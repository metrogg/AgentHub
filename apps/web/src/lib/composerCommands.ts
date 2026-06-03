import type { WorkspaceAgent } from './api'

export type ComposerCommandRange = {
  start: number
  end: number
  query: string
}

export type MentionAgent = Pick<WorkspaceAgent, 'id' | 'name' | 'role' | 'roleType'>

const mentionBoundary = String.raw`(?=$|\s|[，,。.!！?？:：；;）)\]】])`

export function readMentionCommand(text: string, cursor: number): ComposerCommandRange | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  const suffix = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? ''
  const start = match.index + match[1].length
  const prefix = match[2] ?? ''
  return {
    start,
    end: cursor + suffix.length,
    query: `${prefix}${suffix}`,
  }
}

export function readSlashCommand(text: string, cursor: number): ComposerCommandRange | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!match) return null
  const suffix = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? ''
  const start = match.index + match[1].length
  const prefix = match[2] ?? ''
  return {
    start,
    end: cursor + suffix.length,
    query: `${prefix}${suffix}`,
  }
}

export function mentionAliasEntries(agents: MentionAgent[]) {
  const entries: Array<{ alias: string; agentId: string }> = []
  for (const agent of agents) {
    entries.push(
      { alias: agent.name, agentId: agent.id },
      { alias: agent.role, agentId: agent.id },
    )
    if (agent.roleType === 'orchestrator') {
      entries.push(
        { alias: 'orchestrator', agentId: agent.id },
        { alias: 'coordinator', agentId: agent.id },
        { alias: '总指挥', agentId: agent.id },
        { alias: '协调器', agentId: agent.id },
        { alias: '调度', agentId: agent.id },
      )
    }
  }

  const deduped = new Map<string, string>()
  for (const entry of entries) {
    const alias = entry.alias.trim()
    if (!alias) continue
    const key = alias.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, entry.agentId)
  }

  return Array.from(deduped.entries())
    .map(([alias, agentId]) => ({ alias, agentId }))
    .sort((a, b) => b.alias.length - a.alias.length)
}

export function mentionPatternForAliases(aliases: string[]) {
  if (!aliases.length) return null
  return new RegExp(`@(${aliases.map(escapeRegExp).join('|')})${mentionBoundary}`, 'gi')
}

export function extractMentionedAgentIds(text: string, agents: MentionAgent[]) {
  const entries = mentionAliasEntries(agents)
  const pattern = mentionPatternForAliases(entries.map((entry) => entry.alias))
  if (!pattern) return []

  const aliasToAgentId = new Map(entries.map((entry) => [entry.alias.toLowerCase(), entry.agentId]))
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const rawAlias = (match[1] ?? '').trim().toLowerCase()
    const agentId = aliasToAgentId.get(rawAlias)
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    ids.push(agentId)
  }
  return ids
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
