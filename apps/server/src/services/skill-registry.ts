import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
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

  /** Load multiple skills by their IDs. Returns only those found. */
  async loadSkillsByIds(ids: string[]): Promise<LoadedSkill[]> {
    if (!ids.length) return []
    const loaded: LoadedSkill[] = []
    for (const id of ids) {
      const skill = await this.loadSkill(id).catch(() => null)
      if (skill) loaded.push(skill)
    }
    return loaded
  }

  /**
   * Build skill context with preset skills (agent toolbox) loaded first,
   * then auto-matched skills to fill remaining slots.
   */
  async buildSkillContextWithPreset(
    presetIds: string[],
    input: string,
    options: SelectSkillOptions = {},
  ): Promise<string> {
    const limit = Math.max(0, Math.min(options.limit ?? 2, 5))
    if (limit === 0 && !presetIds.length) return ''

    // 1. Load preset skills (agent toolbox)
    const presetSkills = await this.loadSkillsByIds(presetIds)
    const presetIdSet = new Set(presetSkills.map((s) => normalizeToken(s.id)))

    // 2. Auto-match remaining slots
    const remainingSlots = Math.max(0, limit - presetSkills.length)
    let autoMatched: LoadedSkill[] = []
    if (remainingSlots > 0) {
      const allSelected = await this.selectSkills(input, { ...options, limit: limit + presetSkills.length })
      autoMatched = allSelected.filter((s) => !presetIdSet.has(normalizeToken(s.id))).slice(0, remainingSlots)
    }

    const allSkills = [...presetSkills, ...autoMatched]
    if (!allSkills.length) return ''

    return [
      'Active skills loaded for this task:',
      ...allSkills.map((skill) => {
        const tag = presetIdSet.has(normalizeToken(skill.id)) ? ' [专属工具箱]' : ''
        return [
          `## ${skill.name}${tag}`,
          `Description: ${skill.description}`,
          `Source: ${skill.skillPath}`,
          limitText(skill.body, 8000),
        ].join('\n')
      }),
    ].join('\n\n')
  }
}

export const globalSkillRegistry = new SkillRegistry()

function defaultSkillRoots() {
  const configuredValue = env.AGENTHUB_SKILLS_ROOT ?? (env.AGENTHUB_APP_DATA_DIR ? resolve(env.AGENTHUB_APP_DATA_DIR, 'skills') : undefined)
  const configured = configuredValue
    ?.split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (isAbsolute(item) ? item : resolve(projectRoot, item))) ?? []

  const roots = [
    ...configured,
    resolve(projectRoot, '.codex', 'skills'),
    resolve(projectRoot, '.agents', 'skills'),
    resolve(projectRoot, '.claude', 'skills'),
    resolve(projectRoot, 'skills'),
    resolve(projectRoot, 'storage', 'skills'),
  ]

  const home = homedir()
  if (home) {
    roots.push(resolve(home, '.codex', 'skills'))
    roots.push(resolve(home, '.agents', 'skills'))
    roots.push(resolve(home, '.claude', 'skills'))
  }
  if (env.CODEX_HOME) roots.push(resolve(env.CODEX_HOME, 'skills'))
  return [...new Set(roots)]
}

async function childDirectories(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childPath = resolve(root, entry.name)
    if (entry.isDirectory()) {
      dirs.push(childPath)
      continue
    }
    if (!entry.isSymbolicLink()) continue
    const info = await stat(childPath).catch(() => null)
    if (info?.isDirectory()) dirs.push(childPath)
  }
  return dirs
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
    source: sourceLabel(rootPath),
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

function sourceLabel(rootPath: string) {
  const normalized = rootPath.replace(/\\/g, '/').toLowerCase()
  const projectCodexSkills = resolve(projectRoot, '.codex', 'skills').replace(/\\/g, '/').toLowerCase()
  const projectAgentsSkills = resolve(projectRoot, '.agents', 'skills').replace(/\\/g, '/').toLowerCase()
  const projectClaudeSkills = resolve(projectRoot, '.claude', 'skills').replace(/\\/g, '/').toLowerCase()
  const projectSkills = resolve(projectRoot, 'skills').replace(/\\/g, '/').toLowerCase()
  const storageSkills = resolve(projectRoot, 'storage', 'skills').replace(/\\/g, '/').toLowerCase()
  const home = homedir()
  const homeCodexSkills = home ? resolve(home, '.codex', 'skills').replace(/\\/g, '/').toLowerCase() : ''
  const homeAgentsSkills = home ? resolve(home, '.agents', 'skills').replace(/\\/g, '/').toLowerCase() : ''
  const homeClaudeSkills = home ? resolve(home, '.claude', 'skills').replace(/\\/g, '/').toLowerCase() : ''
  if (normalized === projectCodexSkills) return 'Codex 项目'
  if (normalized === projectAgentsSkills) return 'Agents 项目'
  if (normalized === projectClaudeSkills) return 'Claude 项目'
  if (normalized === projectSkills) return '项目内置'
  if (normalized === storageSkills) return '本机安装'
  if (normalized === homeCodexSkills) return 'Codex 本机'
  if (normalized === homeAgentsSkills) return 'Agents 本机'
  if (normalized === homeClaudeSkills) return 'Claude 本机'
  if (env.CODEX_HOME && normalized === resolve(env.CODEX_HOME, 'skills').replace(/\\/g, '/').toLowerCase()) return 'Codex 本机'
  return basename(rootPath) || rootPath
}
