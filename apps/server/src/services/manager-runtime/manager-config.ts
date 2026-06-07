import {
  ensureManagerAgentContract,
  readManagerPromptContract,
  resolveManagerAgentContractWorkspace,
  type EnsureManagerAgentContractInput,
  type ManagerAgentContractWorkspace,
} from '../agent-contract'

export type ManagerConfigPaths = ManagerAgentContractWorkspace

export function managerConfigPaths(workspaceId?: string | null): ManagerConfigPaths {
  return resolveManagerAgentContractWorkspace(workspaceId)
}

export function ensureManagerConfig(workspaceId?: string | null, input: EnsureManagerAgentContractInput = {}) {
  return ensureManagerAgentContract({ ...input, managerId: workspaceId })
}

export function readManagerPromptConfig(workspaceId?: string | null) {
  return readManagerPromptContract(workspaceId)
}
