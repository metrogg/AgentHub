import {
  AGENT_ROLE_AVATAR_PATHS,
  AGENT_ROLE_DARK_AVATAR_PATHS,
  ROLE_PRESETS,
  inferRoleType as inferSharedRoleType,
  type AgentRoleType,
} from '@agenthub/shared'

type PresetRoleType = Exclude<AgentRoleType, 'custom'>
type AvatarRoleType = keyof typeof AGENT_ROLE_AVATAR_PATHS

export type AgentVisualInput = {
  avatar?: string | null
  capabilityTags?: string[] | null
  color?: string | null
  name?: string | null
  role?: string | null
  roleType?: string | null
}

const neutralFallbackColors = new Set(['#111827', '#171717', '#000000'])
const roleAvatarEntries = Object.entries(AGENT_ROLE_AVATAR_PATHS) as Array<[AvatarRoleType, string]>
const lightToDarkAvatar = new Map<string, string>(
  roleAvatarEntries.map(([roleType, avatar]) => [
    avatar,
    AGENT_ROLE_DARK_AVATAR_PATHS[roleType] ?? avatar,
  ]),
)
const darkToLightAvatar = new Map<string, string>(
  Object.entries(AGENT_ROLE_DARK_AVATAR_PATHS).map(([roleType, avatar]) => [
    avatar,
    AGENT_ROLE_AVATAR_PATHS[roleType as AvatarRoleType] ?? avatar,
  ]),
)

export function currentAgentHubTheme(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.dataset.agenthubTheme
    if (theme === 'dark' || theme === 'light') return theme
  }
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark'
  }
  return 'light'
}

export function resolveAgentRoleType(agent: AgentVisualInput): AgentRoleType {
  if (agent.roleType && agent.roleType in ROLE_PRESETS) return agent.roleType as PresetRoleType
  const matchedRole = inferVisualRoleType(agent)
  if (matchedRole) return matchedRole
  if (agent.roleType === 'custom') return 'custom'
  return inferSharedRoleType({
    capabilityTags: agent.capabilityTags ?? undefined,
    name: agent.name ?? undefined,
    role: agent.role ?? undefined,
    roleType: agent.roleType ?? undefined,
  })
}

function inferVisualRoleType(agent: AgentVisualInput): PresetRoleType | null {
  const name = normalizeVisualText(agent.name)
  if (name === 'orchestrator' || name.includes('orchestrator')) return 'orchestrator'
  if (name === 'designer' || name.includes('designer')) return 'architect'
  if (name === 'researcher' || name.includes('researcher')) return 'researcher'
  if (name === 'builder' || name.includes('builder')) return 'coder'
  if (name === 'qareviewer' || name.includes('qareviewer') || name.includes('reviewer')) return 'reviewer'

  const tags = new Set((agent.capabilityTags ?? []).map(normalizeVisualText))
  if (tags.has('orchestrate') || tags.has('coordinate') || tags.has('dispatch')) return 'orchestrator'
  if (tags.has('design') || tags.has('ux') || tags.has('informationarchitecture')) return 'architect'
  if (tags.has('research') || tags.has('sources') || tags.has('facts')) return 'researcher'
  if (tags.has('code') || tags.has('implementation') || tags.has('frontend')) return 'coder'
  if (tags.has('review') || tags.has('qa') || tags.has('quality') || tags.has('acceptance')) return 'reviewer'

  return null
}

function normalizeVisualText(value?: string | null) {
  return (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export function defaultAgentAvatarPath(agent: AgentVisualInput): string | null {
  const roleType = resolveAgentRoleType(agent)
  const avatarRole = roleWithAvatar(roleType)
  return avatarRole ? AGENT_ROLE_AVATAR_PATHS[avatarRole] : null
}

export function defaultAgentColor(agent: AgentVisualInput): string | null {
  const roleType = resolveAgentRoleType(agent)
  if (roleType === 'custom') return null
  return ROLE_PRESETS[roleType]?.color ?? null
}

export function resolveAgentColor(agent: AgentVisualInput, fallback = '#111827'): string {
  const rawColor = agent.color?.trim()
  const presetColor = defaultAgentColor(agent)
  if (!rawColor) return presetColor ?? fallback
  if (presetColor && neutralFallbackColors.has(rawColor.toLowerCase())) return presetColor
  return rawColor
}

export function resolveAgentAvatarSrc(
  agent: AgentVisualInput,
  theme: 'light' | 'dark' = currentAgentHubTheme(),
): string | null {
  const explicitAvatar = agent.avatar?.trim() || null
  const defaultAvatar = defaultAgentAvatarPath(agent)
  const avatar = explicitAvatar ?? defaultAvatar
  if (!avatar) return null

  if (theme === 'dark') {
    return lightToDarkAvatar.get(avatar) ?? defaultDarkAvatarPath(agent) ?? avatar
  }
  return darkToLightAvatar.get(avatar) ?? avatar
}

export function resolveAgentInitial(agent: AgentVisualInput, fallback?: string | null): string {
  return (agent.name?.trim().slice(0, 1) || fallback?.trim().slice(0, 1) || '+').toUpperCase()
}

export function withAgentVisualDefaults<T extends AgentVisualInput>(
  agent: T,
): T & { avatar: string | null; color: string } {
  const avatar = agent.avatar ?? defaultAgentAvatarPath(agent)
  const color = resolveAgentColor(agent)
  return {
    ...agent,
    avatar,
    color,
  }
}

function defaultDarkAvatarPath(agent: AgentVisualInput): string | null {
  const roleType = resolveAgentRoleType(agent)
  const avatarRole = roleWithAvatar(roleType)
  return avatarRole ? AGENT_ROLE_DARK_AVATAR_PATHS[avatarRole] : null
}

function roleWithAvatar(roleType: AgentRoleType): AvatarRoleType | null {
  return roleType in AGENT_ROLE_AVATAR_PATHS ? (roleType as AvatarRoleType) : null
}
