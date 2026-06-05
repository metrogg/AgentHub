import { db, workspaceTasks, eq } from '@agenthub/db'
import type { AgentRunProfile } from '../agent-runner'
import { buildAgentProfile, type AgentRow } from '../agents/profile-builder'
import { cleanProjectPath } from './utils'
import { TaskStatus } from '@agenthub/shared'

/**
 * @deprecated 使用 buildAgentProfile 代替。保留向后兼容。
 */
export function workspaceAgentRunProfile(
  agent: AgentRow,
  projectPath?: string | null,
): AgentRunProfile {
  return buildAgentProfile(agent, cleanProjectPath(projectPath))
}

export async function markWorkspaceTaskAfterRun(taskId: string, ok: boolean) {
  await db
    .update(workspaceTasks)
    .set({ status: ok ? TaskStatus.Done : TaskStatus.Failed, updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
}
