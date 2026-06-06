import type { workspaceAgents } from '@agenthub/db'
import {
  ensureWorkerAgentContract,
  resolveWorkerAgentContractRoot,
  resolveWorkerAgentContractWorkspace,
  type WorkerAgentContractWorkspace,
} from '../agent-contract'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

export type WorkerWorkspace = WorkerAgentContractWorkspace

export function resolveWorkerWorkspaceRoot(): string {
  return resolveWorkerAgentContractRoot()
}

export function resolveWorkerWorkspace(workerInstanceId: string): WorkerWorkspace {
  return resolveWorkerAgentContractWorkspace(workerInstanceId)
}

export async function ensureWorkerWorkspace(
  workerInstanceId: string,
  agent: WorkspaceAgentRow,
): Promise<WorkerWorkspace> {
  return ensureWorkerAgentContract({ workerInstanceId, agent })
}
