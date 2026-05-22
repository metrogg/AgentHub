import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env'

export interface SkillSummary {
  id: string
  name: string
  description: string
  rootPath: string
  skillPath: string
  source: string
}

export interface LoadedSkill extends SkillSummary {
  body: string
}

interface SelectSkillOptions {
  capabilityTags?: string[]
  limit?: number
}

const serviceDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serviceDir, '../../../..')
const frontmatterPattern = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/

export class SkillRegistry {
  constructor(private readonly roots = defaultSkillRoots()) {}

  async listSkills(): Promise<SkillSummary[]> {
    const found: SkillSummary[] = []
    const seen = new Set<string>()

    for (const root of this.roots) {
      if (!existsSync(root)) continue
      for (const skillPath of await childDirectories(root)) {
        const summary = await readSkillSummary(skillPath, root).catch(() => null)
        if (!summary) continue
        const key = `${summary.source}:${summary.id}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        found.push(summary)
      }
    }

    return found.sort((a, b) => a.name.localeCompare(b.name))
  }

  async selectSkills(input: string, options: SelectSkillOptions = {}): Promise<LoadedSkill[]> {
    const limit = Math.max(0, Math.min(options.limit ?? 2, 5))
    if (limit === 0) return []

    const lowered = input.toLowerCase()
    const capabilityText = (options.capabilityTags ?? []).join(' ').toLowerCase()
    const scored = (await this.listSkills())
      .map((skill) => ({ skill, score: scoreSkill(skill, lowered, capabilityText) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    const loaded: LoadedSkill[] = []
    for (const item of scored) {
      const full = await this.loadSkill(item.skill.id).catch(() => null)
      if (full) loaded.push(full)
    }
    return loaded
  }

  async loadSkill(nameOrId: string): Promise<LoadedSkill | null> {
    const needle = normalizeToken(nameOrId)
    if (!needle) return null
    const skills = await this.listSkills()
    const match = skills.find((skill) => normalizeToken(skill.id) === needle || normalizeToken(skill.name) === needle)
    if (!match) return null
    const raw = await readFile(resolve(match.skillPath, 'SKILL.md'), 'utf8')
    const body = raw.replace(frontmatterPattern, '').trim()
    return { ...match, body }
  }

  async buildSkillContext(input: string, options: SelectSkillOptions = {}): Promise<string> {
    const selected = await this.selectSkills(input, options)
    if (!selected.length) return ''

    return [
      'Active skills loaded for this task:',
      ...selected.map((skill) =>
        [
          `## ${skill.name}`,
          `Description: ${skill.description}`,
          `Source: ${skill.skillPath}`,
          limitText(skill.body, 8000),
        ].join('\n')
      ),
    ].join('\n\n')
  }
}

export const globalSkillRegistry = new SkillRegistry()

function defaultSkillRoots() {
  const configured = env.AGENTHUB_SKILLS_ROOT
    ?.split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (isAbsolute(item) ? item : resolve(projectRoot, item))) ?? []

  const roots = [
    ...configured,
    resolve(projectRoot, 'skills'),
    resolve(projectRoot, 'storage', 'skills'),
  ]

  if (env.CODEX_HOME) roots.push(resolve(env.CODEX_HOME, 'skills'))
  return [...new Set(roots)]
}

async function childDirectories(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => resolve(root, entry.name))
}

async function readSkillSummary(skillPath: string, rootPath: string): Promise<SkillSummary | null> {
  const filePath = resolve(skillPath, 'SKILL.md')
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) return null

  const raw = await readFile(filePath, 'utf8')
  const frontmatter = parseFrontmatter(raw)
  const id = basename(skillPath)
  const name = frontmatter.name || id
  const description = frontmatter.description || ''
  return {
    id,
    name,
    description,
    rootPath,
    skillPath,
    source: basename(rootPath) || rootPath,
  }
}

function parseFrontmatter(raw: string) {
  const match = raw.match(frontmatterPattern)
  if (!match?.[1]) return {} as Record<string, string>

  const values: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair?.[1]) continue
    values[pair[1]] = stripYamlString(pair[2] ?? '')
  }
  return values
}

function stripYamlString(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function scoreSkill(skill: SkillSummary, loweredInput: string, capabilityText: string) {
  const name = skill.name.toLowerCase()
  const id = skill.id.toLowerCase()
  let score = 0

  if (loweredInput.includes(`$${name}`) || loweredInput.includes(`$${id}`)) score += 100
  if (loweredInput.includes(`@skill:${name}`) || loweredInput.includes(`@skill:${id}`)) score += 100
  if (loweredInput.includes(name) || loweredInput.includes(id)) score += 20
  if (capabilityText.includes(name) || capabilityText.includes(id)) score += 12

  const searchable = `${skill.name} ${skill.description}`.toLowerCase()
  for (const token of tokenize(searchable)) {
    if (loweredInput.includes(token)) score += 1
    if (capabilityText.includes(token)) score += 1
  }
  return score
}

function tokenize(value: string) {
  return [
    ...new Set(
      value
        .split(/[^a-z0-9\u4e00-\u9fa5_-]+/i)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 4)
    ),
  ].slice(0, 80)
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase()
}

function limitText(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... skill truncated ...`
}
