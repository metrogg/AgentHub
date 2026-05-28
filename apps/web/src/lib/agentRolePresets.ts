import type { AgentConfigInput, AgentRelationType, AgentRoleType } from './api'
import {
  ROLE_PRESETS,
  DEFAULT_CODE_TEAM_RELATIONS,
  inferRoleType as sharedInferRoleType,
} from '@agenthub/shared'

export interface AgentRolePreset extends AgentConfigInput {
  roleType: Exclude<AgentRoleType, 'custom'>
  label: string
  acceptsTaskTypes: string[]
  produces: string[]
}

const roleToLabel: Record<Exclude<AgentRoleType, 'custom'>, string> = {
  clarifier: '需求澄清',
  architect: '架构规划',
  researcher: '资料研究',
  coder: '代码实现',
  verifier: '验证执行',
  reviewer: '代码审查',
  integrator: '汇总交付',
}

function sharedPresetToFrontend(key: Exclude<AgentRoleType, 'custom'>): AgentRolePreset {
  const p = ROLE_PRESETS[key]
  return {
    roleType: key,
    label: roleToLabel[key],
    name: p.name,
    role: p.role,
    description: p.description,
    systemPrompt: p.systemPrompt,
    color: p.color,
    runtimeType: p.runtimeType,
    codeAgentType: p.codeAgentType ?? null,
    capabilityTags: p.capabilityTags,
    toolPermissions: p.toolPermissions,
    sandboxPolicy: p.sandboxPolicy,
    contextPolicy: p.contextPolicy,
    autoInvoke: p.autoInvoke,
    approvalRequired: p.approvalRequired,
    acceptsTaskTypes: p.roleProfile.acceptsTaskTypes,
    produces: p.roleProfile.produces,
  }
}

export const agentRolePresets: AgentRolePreset[] = (
  Object.keys(ROLE_PRESETS) as Array<Exclude<AgentRoleType, 'custom'>>
).map(sharedPresetToFrontend)

export const defaultAgentRelations: Array<{
  sourceRoleType: AgentRoleType
  targetRoleType: AgentRoleType
  relationType: AgentRelationType
  note: string
}> = DEFAULT_CODE_TEAM_RELATIONS

export function presetForRole(roleType?: AgentRoleType) {
  if (!roleType || roleType === 'custom') return undefined
  return agentRolePresets.find((preset) => preset.roleType === roleType)
}

export function inferRoleType(input: Partial<Pick<AgentConfigInput, 'name' | 'role' | 'capabilityTags' | 'roleType'>>): AgentRoleType {
  return sharedInferRoleType({
    roleType: input.roleType,
    name: input.name,
    role: input.role,
    capabilityTags: input.capabilityTags,
  })
}
