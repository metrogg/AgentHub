import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { env } from '../env'
import { globalSkillRegistry } from '../services/skill-registry'

const routeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(routeDir, '../../../..')
const installedSkillsRoot = env.AGENTHUB_SKILLS_ROOT?.split(delimiter)[0] || (env.AGENTHUB_APP_DATA_DIR ? resolve(env.AGENTHUB_APP_DATA_DIR, 'skills') : resolve(projectRoot, 'storage', 'skills'))

const installSkillSchema = z.object({
  sourceUrl: z.string().trim().min(1).max(1000),
  id: z.string().max(80).optional(),
})

const skillhubSearchSchema = z.object({
  q: z.string().trim().min(1).max(120),
})

const skillhubInstallSchema = z.object({
  slug: z.string().trim().min(1).max(120),
})

export const skillRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    return c.json({ items: await globalSkillRegistry.listSkills() })
  })
  .get('/skillhub/search', zValidator('query', skillhubSearchSchema), async (c) => {
    const { q } = c.req.valid('query')
    const result = await searchSkillhubNative(q)
    if (!result.ok) {
      return c.json({ ok: false, items: [], message: result.message || 'SkillHub 搜索失败' }, 500)
    }
    return c.json(result)
  })
  .post('/install', zValidator('json', installSkillSchema), async (c) => {
    const { sourceUrl, id } = c.req.valid('json')
    try {
      const result = isNpxSkillsAddCommand(sourceUrl)
        ? await installSkillFromNpxCommand(sourceUrl)
        : await installSkillFromUrl(sourceUrl, id)
      return c.json(result)
    } catch (error) {
      return c.json({
        ok: false,
        installed: null,
        message: getInstallErrorMessage(error),
      })
    }
  })
  .post('/skillhub/install', zValidator('json', skillhubInstallSchema), async (c) => {
    const { slug } = c.req.valid('json')
    const result = await installSkillhubNative(slug)
    if (!result.ok) return c.json(result, 500)
    const installed = await globalSkillRegistry.loadSkill(result.slug)
    return c.json({
      ok: true,
      installed,
      message: installed ? `已安装 skill:${installed.id}` : `已安装 ${result.slug}`,
    })
  })
  .get('/:id', async (c) => {
    const skill = await globalSkillRegistry.loadSkill(c.req.param('id'))
    if (!skill) return c.json({ message: 'Skill 不存在' }, 404)
    return c.json(skill)
  })

async function searchSkillhubNative(q: string) {
  try {
    const url = new URL('https://lightmake.site/api/v1/search')
    url.searchParams.set('q', q)
    url.searchParams.set('limit', '40')
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AgentHub/SkillHub',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = (await response.json()) as any
    const rawItems = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.items) ? payload.items : []
    const items = rawItems.map(normalizeSkillhubItem).filter(Boolean).slice(0, 40)
    return { ok: true, items, message: `SkillHub 搜索完成：${items.length} 个结果` }
  } catch (error: any) {
    return { ok: false, items: [], message: error?.message || 'SkillHub 搜索失败' }
  }
}

async function installSkillhubNative(slug: string) {
  const targetDir = resolve(installedSkillsRoot, slug)
  if (!isInside(targetDir, installedSkillsRoot)) return { ok: false, slug, message: 'Invalid skill slug' }
  const stageDir = await mkdtemp(resolve(tmpdir(), 'agenthub-skill-'))
  try {
    const zipBytes = await downloadSkillhubZip(slug)
    await extractZip(zipBytes, stageDir)
    const skillRoot = await findExtractedSkillRoot(stageDir)
    if (!skillRoot) throw new Error('下载包中没有找到 SKILL.md')
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(skillRoot, targetDir, { recursive: true })
    return { ok: true, slug, message: `已安装 ${slug}` }
  } catch (error: any) {
    return { ok: false, slug, message: error?.message || `SkillHub 安装失败：${slug}` }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installSkillFromNpxCommand(input: string) {
  const parsed = parseNpxSkillsAddCommand(input)
  if (!parsed) {
    throw new Error('仅支持 npx skills@latest add owner/repo 形式的安装命令。')
  }

  const before = await globalSkillRegistry.listSkills()
  const beforeKeys = new Set(before.map((skill) => `${skill.source}:${skill.id}`.toLowerCase()))
  const result = await runNpxSkillsAdd(parsed.packageRef, parsed.extraArgs)
  if (result.code !== 0) {
    throw new Error(cleanSkillhubText(result.output) || `npx skills 安装失败：${parsed.packageRef}`)
  }

  const after = await globalSkillRegistry.listSkills()
  const installed = after.find((skill) => !beforeKeys.has(`${skill.source}:${skill.id}`.toLowerCase()))
    ?? after.find((skill) => skill.id.toLowerCase() === slugify(parsed.packageRef.split('/').pop() || parsed.packageRef))
    ?? null

  return {
    ok: true,
    installed,
    message: `已执行 npx skills 安装：${parsed.packageRef}`,
  }
}

function isNpxSkillsAddCommand(value: string) {
  return /^\s*npx(?:\s|$)/i.test(value)
}

function parseNpxSkillsAddCommand(input: string) {
  const args = splitCommand(input)
  let index = 0
  if (args[index]?.toLowerCase() !== 'npx') return null
  index += 1

  if (['--yes', '-y'].includes(args[index]?.toLowerCase() ?? '')) index += 1
  if (args[index]?.toLowerCase() !== 'skills@latest') return null
  index += 1
  if (args[index]?.toLowerCase() !== 'add') return null
  index += 1

  const packageRef = normalizeSkillsPackageRef(args[index] ?? '')
  if (!packageRef) return null
  index += 1

  const allowedExtraArgs = new Set(['-g', '--global', '-y', '--yes', '--copy', '--all', '--full-depth'])
  const extraArgs: string[] = []
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg || !allowedExtraArgs.has(arg)) return null
    extraArgs.push(arg)
  }

  return { packageRef, extraArgs }
}

function normalizeSkillsPackageRef(value: string) {
  const trimmed = value.trim().replace(/\.git$/i, '')
  const github = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(trimmed)
  if (github?.[1] && github[2]) return `${github[1]}/${github[2]}`
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : ''
}

function splitCommand(input: string) {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

async function runNpxSkillsAdd(packageRef: string, extraArgs: string[]) {
  const args = [
    'npx',
    '--yes',
    'skills@latest',
    'add',
    packageRef,
    ...extraArgs.filter((arg) => !['--yes', '-y'].includes(arg)),
    '-y',
  ]
  try {
    const proc = Bun.spawn(buildHostCommand(args), {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // Process may have already exited.
      }
    }, 120_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
      proc.exited,
    ])
    clearTimeout(timer)
    return { code, output: [stdout, stderr].filter(Boolean).join('\n').trim() }
  } catch (error: any) {
    return { code: 127, output: error?.message || 'npx skills failed to start.' }
  }
}

function buildHostCommand(args: string[]) {
  if (process.platform !== 'win32') return args
  return [getWindowsCommandShell(), '/d', '/s', '/c', args.map(quoteForCmd).join(' ')]
}

function getWindowsCommandShell() {
  return process.env.ComSpec || `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`
}

function quoteForCmd(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function normalizeSkillhubItem(value: any) {
  const slug = stringValue(value?.slug || value?.id || value?.name)
  if (!slug) return null
  const title = stringValue(value?.displayName || value?.title || value?.name || slug)
  const description = stringValue(value?.description_zh || value?.description || value?.summary)
  const version = stringValue(value?.version)
  return {
    slug,
    title: cleanSkillhubText(title || slug),
    description: cleanSkillhubText(description),
    ...(version ? { version } : {}),
    source: stringValue(value?.source) || 'SkillHub',
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

async function downloadSkillhubZip(slug: string) {
  const urls = [
    `https://lightmake.site/api/v1/download?slug=${encodeURIComponent(slug)}`,
    `https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/${encodeURIComponent(slug)}.zip`,
  ]
  let lastError = ''
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/zip, application/octet-stream, */*',
          'User-Agent': 'AgentHub/SkillHub',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('下载内容不是 zip 包')
      return bytes
    } catch (error: any) {
      lastError = error?.message || String(error)
    }
  }
  throw new Error(lastError || '下载 SkillHub 技能失败')
}

async function extractZip(zip: Buffer, targetDir: string) {
  const entries = readZipEntries(zip)
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const filePath = resolve(targetDir, entry.name.replace(/\\/g, '/'))
    if (!isInside(filePath, targetDir)) throw new Error(`非法 zip 路径：${entry.name}`)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, entry.data)
  }
}

function readZipEntries(zip: Buffer) {
  const eocdOffset = findEndOfCentralDirectory(zip)
  if (eocdOffset < 0) throw new Error('zip 目录损坏')
  const totalEntries = zip.readUInt16LE(eocdOffset + 10)
  let centralOffset = zip.readUInt32LE(eocdOffset + 16)
  const entries: Array<{ name: string; data: Buffer }> = []

  for (let index = 0; index < totalEntries; index += 1) {
    if (zip.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = zip.readUInt16LE(centralOffset + 10)
    const compressedSize = zip.readUInt32LE(centralOffset + 20)
    const fileNameLength = zip.readUInt16LE(centralOffset + 28)
    const extraLength = zip.readUInt16LE(centralOffset + 30)
    const commentLength = zip.readUInt16LE(centralOffset + 32)
    const localOffset = zip.readUInt32LE(centralOffset + 42)
    const name = zip.slice(centralOffset + 46, centralOffset + 46 + fileNameLength).toString('utf8')
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = zip.slice(dataStart, dataStart + compressedSize)
    let data: Buffer
    if (method === 0) data = compressed
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error(`暂不支持 zip 压缩方式：${method}`)
    entries.push({ name, data })
    centralOffset += 46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

function findEndOfCentralDirectory(zip: Buffer) {
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 66_000); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

async function findExtractedSkillRoot(stageDir: string) {
  if (existsSync(resolve(stageDir, 'SKILL.md'))) return stageDir
  const entries = await readdir(stageDir, { withFileTypes: true })
  const child = entries.find((entry) => entry.isDirectory())
  if (!child) return null
  const childPath = resolve(stageDir, child.name)
  return existsSync(resolve(childPath, 'SKILL.md')) ? childPath : null
}

function isInside(target: string, root: string) {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

function cleanSkillhubText(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[�]{2,}/g, '')
    .trim()
}

function getInstallErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return cleanSkillhubText(message) || 'Skill 安装失败'
}

async function installSkillFromUrl(sourceUrl: string, requestedId?: string) {
  let skillUrl: string
  try {
    skillUrl = normalizeSkillUrl(sourceUrl)
  } catch {
    throw new Error('请输入有效的 SKILL.md / GitHub 技能链接，或 npx skills@latest add owner/repo 命令。')
  }
  const response = await fetch(skillUrl, {
    headers: { Accept: 'text/plain, text/markdown, */*' },
  })
  if (!response.ok) {
    throw new Error(`Skill download failed: HTTP ${response.status}`)
  }
  const content = await response.text()
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---/.test(content) || !/name:\s*/i.test(content)) {
    throw new Error('下载内容不像有效的 SKILL.md，请使用包含 frontmatter 的技能文件链接。')
  }

  const frontmatter = parseFrontmatter(content)
  const skillId = slugify(requestedId || frontmatter.name || frontmatter.id || basename(dirname(new URL(skillUrl).pathname)) || 'skill')
  const skillDir = resolve(installedSkillsRoot, skillId)
  if (!isInside(skillDir, installedSkillsRoot)) throw new Error('Invalid skill id')

  await mkdir(skillDir, { recursive: true })
  await writeFile(resolve(skillDir, 'SKILL.md'), content, 'utf8')
  const installed = await globalSkillRegistry.loadSkill(skillId)

  return {
    ok: true,
    installed: installed ?? {
      id: skillId,
      name: frontmatter.name || skillId,
      description: frontmatter.description || '',
      rootPath: installedSkillsRoot,
      skillPath: skillDir,
      source: 'skills',
    },
    message: `已安装 skill:${skillId}`,
  }
}

function normalizeSkillUrl(value: string) {
  const url = new URL(value)
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    const blobOrTree = parts[2]
    if (parts.length >= 5 && blobOrTree === 'blob') {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`
    }
    if (parts.length >= 5 && blobOrTree === 'tree') {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}/SKILL.md`
    }
  }
  if (!/SKILL\.md$/i.test(url.pathname) && !url.hostname.includes('raw.githubusercontent.com')) {
    const next = new URL(url.toString().replace(/\/$/, ''))
    next.pathname = `${next.pathname}/SKILL.md`
    return next.toString()
  }
  return url.toString()
}

function parseFrontmatter(raw: string) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const values: Record<string, string> = {}
  if (!match?.[1]) return values
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair?.[1]) values[pair[1]] = stripYamlString(pair[2] ?? '')
  }
  return values
}

function stripYamlString(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'skill'
  )
}
