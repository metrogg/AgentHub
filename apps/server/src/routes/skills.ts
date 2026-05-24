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

export const skillRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    return c.json({ items: await globalSkillRegistry.listSkills() })
  })
  .post('/install', zValidator('json', installSkillSchema), async (c) => {
    const { sourceUrl, id } = c.req.valid('json')
    const result = await installSkillFromUrl(sourceUrl, id)
    return c.json(result)
  })

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
