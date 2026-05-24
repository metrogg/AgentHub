import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { globalSkillRegistry } from '../services/skill-registry'

const routeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(routeDir, '../../../..')
const installedSkillsRoot = resolve(projectRoot, 'storage', 'skills')

const installSkillSchema = z.object({
  sourceUrl: z.string().url(),
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
    const result = await runSkillhub(['--skip-self-upgrade', '--dir', installedSkillsRoot, 'search', q])
    if (result.code !== 0) {
      return c.json({ ok: false, items: [], message: result.output || 'SkillHub 搜索失败' }, 500)
    }
    return c.json({ ok: true, items: parseSkillhubSearch(result.output), message: result.output })
  })
  .post('/install', zValidator('json', installSkillSchema), async (c) => {
    const { sourceUrl, id } = c.req.valid('json')
    const result = await installSkillFromUrl(sourceUrl, id)
    return c.json(result)
  })
  .post('/skillhub/install', zValidator('json', skillhubInstallSchema), async (c) => {
    const { slug } = c.req.valid('json')
    const result = await runSkillhub(['--skip-self-upgrade', '--dir', installedSkillsRoot, 'install', slug])
    if (result.code !== 0) {
      return c.json({ ok: false, message: result.output || `SkillHub 安装失败：${slug}` }, 500)
    }
    const installed = await globalSkillRegistry.loadSkill(slug)
    return c.json({
      ok: true,
      installed,
      message: installed ? `已安装 skill:${installed.id}` : result.output || `已安装 ${slug}`,
    })
  })
  .get('/:id', async (c) => {
    const skill = await globalSkillRegistry.loadSkill(c.req.param('id'))
    if (!skill) return c.json({ message: 'Skill 不存在' }, 404)
    return c.json(skill)
  })

async function runSkillhub(args: string[]) {
  try {
    const proc = Bun.spawn(['skillhub', ...args], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      decodeProcessOutput(proc.stdout).catch(() => ''),
      decodeProcessOutput(proc.stderr).catch(() => ''),
    ])
    return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') }
  } catch (error: any) {
    return { code: 1, output: error?.message || 'skillhub command not found' }
  }
}

function parseSkillhubSearch(output: string) {
  const items: Array<{ slug: string; title: string; description: string; version?: string; source: string }> = []
  let current: { slug: string; title: string; descriptions: string[]; version?: string } | null = null
  const pushCurrent = () => {
    if (!current) return
    const item: { slug: string; title: string; description: string; version?: string; source: string } = {
      slug: current.slug,
      title: cleanSkillhubText(current.title) || current.slug,
      description: chooseDescription(current.descriptions),
      source: 'SkillHub',
    }
    if (current.version) item.version = current.version
    items.push(item)
  }
  for (const line of output.split(/\r?\n/)) {
    const trimmedRight = line.trimEnd()
    if (!trimmedRight.trim() || /^You can use/i.test(trimmedRight)) continue
    const entry = /^([a-z0-9][a-z0-9_-]{1,120})\s{2,}(.+)$/.exec(trimmedRight)
    if (entry?.[1]) {
      pushCurrent()
      current = {
        slug: entry[1],
        title: entry[2]?.trim() || entry[1],
        descriptions: [],
      }
      continue
    }
    if (!current) continue
    const version = /^\s*-\s*version:\s*(.+)$/i.exec(trimmedRight)
    if (version?.[1]) {
      current.version = version[1].trim()
      continue
    }
    const description = /^\s*-\s*(.+)$/.exec(trimmedRight) ?? /^\s{2,}(.+)$/.exec(trimmedRight)
    if (description?.[1]) {
      current.descriptions.push(description[1].trim())
    }
  }
  pushCurrent()
  return items.slice(0, 40)
}

async function decodeProcessOutput(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return ''
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const gb18030 = new TextDecoder('gb18030' as any, { fatal: false }).decode(bytes)
  return scoreDecodedText(gb18030) > scoreDecodedText(utf8) ? gb18030 : utf8
}

function scoreDecodedText(value: string) {
  const replacementPenalty = (value.match(/\uFFFD/g) ?? []).length * 20
  const chineseBonus = (value.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const readableBonus = (value.match(/[a-z0-9]/gi) ?? []).length * 0.15
  return chineseBonus + readableBonus - replacementPenalty
}

function chooseDescription(values: string[]) {
  const cleaned = values.map(cleanSkillhubText).filter(Boolean)
  if (!cleaned.length) return ''
  return (
    cleaned.find((item) => /[\u4e00-\u9fa5]/.test(item) && item.length >= 8) ??
    cleaned.find((item) => item.length >= 8) ??
    cleaned[0] ??
    ''
  )
}

function cleanSkillhubText(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[�]{2,}/g, '')
    .trim()
}

async function installSkillFromUrl(sourceUrl: string, requestedId?: string) {
  const skillUrl = normalizeSkillUrl(sourceUrl)
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
  if (!skillDir.startsWith(installedSkillsRoot)) throw new Error('Invalid skill id')

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
