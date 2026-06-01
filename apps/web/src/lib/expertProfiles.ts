import {
  AGENT_EXPERT_PROFILES,
  AGENT_EXPERT_TEAM_PROFILES,
  CORE_AGENT_EXPERT_PROFILES,
  CORE_AGENT_EXPERT_TEAM_PROFILES,
  type AgentExpertProfile,
  type AgentExpertTeamProfile,
} from '@agenthub/shared'
import type { AgentConfigInput } from './api'

export type FrontendExpertProfile = AgentExpertProfile
export type FrontendExpertTeamProfile = AgentExpertTeamProfile

export const expertProfiles = CORE_AGENT_EXPERT_PROFILES
export const expertTeamProfiles = CORE_AGENT_EXPERT_TEAM_PROFILES
export const allExpertProfiles = AGENT_EXPERT_PROFILES
export const allExpertTeamProfiles = AGENT_EXPERT_TEAM_PROFILES

export const expertCategoryLabels: Record<AgentExpertProfile['category'], string> = {
  coordination: '协调编排',
  'product-design': '产品设计',
  'technical-engineering': '技术工程',
  'research-analysis': '研究分析',
  'quality-security': '质量安全',
  'content-creation': '内容创作',
  'data-intelligence': '数据智能',
  'operations-release': '运营发布',
  'business-legal': '商业法务',
}

export function expertProfileForId(id?: string | null) {
  if (!id) return undefined
  return allExpertProfiles.find((profile) => profile.id === id)
}

export function expertProfileIdFromDraft(draft: Pick<AgentConfigInput, 'roleProfile'>) {
  const value = draft.roleProfile?.expertProfileId
  return typeof value === 'string' ? value : ''
}

export function expertProfileToAgentConfig(profile: AgentExpertProfile): AgentConfigInput {
  return {
    name: profile.name,
    role: profile.role,
    roleType: profile.roleType,
    description: profile.description,
    avatar: null,
    systemPrompt: profile.systemPrompt,
    roleProfile: {
      expertProfileId: profile.id,
      category: profile.category,
      expertLevel: profile.riskLevel === 'high' ? 'specialist' : 'standard',
      background: profile.background,
      responsibilities: profile.capabilityTags,
      cannotDo: profile.cannotDo,
      acceptsTaskTypes: profile.acceptsTaskTypes,
      outputContract: profile.outputContract,
      qualityGates: profile.qualityGates,
      defaultSkillIds: profile.defaultSkillIds,
      recommendedMcpServers: profile.recommendedMcpServers,
      preferredTopologies: profile.preferredTopologies,
      riskLevel: profile.riskLevel,
    },
    color: profile.color,
    modelId: null,
    runtimeType: profile.runtimeType,
    codeAgentType: profile.runtimeType === 'code-agent' ? (profile.codeAgentType ?? 'codex') : null,
    capabilityTags: profile.capabilityTags,
    skillIds: profile.defaultSkillIds,
    toolPermissions: profile.toolPermissions,
    sandboxPolicy: profile.sandboxPolicy,
    contextPolicy: profile.contextPolicy,
    autoInvoke: profile.autoInvoke,
    approvalRequired: profile.approvalRequired,
  }
}

export function readProfileStringArray(
  roleProfile: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = roleProfile?.[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
