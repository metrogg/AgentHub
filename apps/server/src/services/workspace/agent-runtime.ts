import { db, workspaceTasks, eq } from '@agenthub/db'
import { getActiveRunSessionIds, type AgentRunProfile } from '../agent-runner'
import { cleanProjectPath } from './utils'
import { TaskStatus } from '@agenthub/shared'

export function workspaceAgentRunProfile(
  agent: {
    id: string
    name: string
    role: string
    description: string | null
    systemPrompt: string
    color: string | null
    modelId: string | null
    runtimeType: string
    codeAgentType: string | null
    capabilityTags: string[]
    toolPermissions: string[]
    sandboxPolicy: string
    contextPolicy: string
    approvalRequired: boolean
  },
  projectPath?: string | null
): AgentRunProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? undefined,
    description: agent.description ?? undefined,
    systemPrompt: agent.systemPrompt,
    color: agent.color ?? undefined,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType as AgentRunProfile['runtimeType'],
    codeAgentType: (agent.codeAgentType ?? undefined) as AgentRunProfile['codeAgentType'],
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy as AgentRunProfile['sandboxPolicy'],
    contextPolicy: agent.contextPolicy as AgentRunProfile['contextPolicy'],
    approvalRequired: agent.approvalRequired,
    projectPath: cleanProjectPath(projectPath),
  }
}

export async function markWorkspaceTaskAfterRun(taskId: string, ok: boolean) {
  await db
    .update(workspaceTasks)
    .set({ status: ok ? TaskStatus.Done : TaskStatus.Failed, updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
}

export { getActiveRunSessionIds }
