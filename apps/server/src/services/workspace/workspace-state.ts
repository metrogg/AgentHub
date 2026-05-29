import { logger } from '../../lib/logger'
import { db, workspaceStates, eq } from '@agenthub/db'

export interface WorkspaceAgentOutput {
  agentId: string
  agentName: string
  role: string
  content: string
  timestamp: string
}

export interface WorkspaceTaskItem {
  id: string
  title: string
  agentName: string
  status: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

export interface WorkspaceState {
  version: number
  workspaceId: string
  currentPhase: 'planning' | 'researching' | 'implementing' | 'reviewing' | 'idle'
  goal: string
  plan?: string
  planMarkdown?: string
  completedTasks: WorkspaceTaskItem[]
  pendingIssues: string[]
  agentOutputs: WorkspaceAgentOutput[]
  lastUpdatedAt: string
}

const STATE_VERSION = 1

function createInitialWorkspaceState(workspaceId: string, goal: string): WorkspaceState {
  return {
    version: STATE_VERSION,
    workspaceId,
    currentPhase: 'idle',
    goal,
    completedTasks: [],
    pendingIssues: [],
    agentOutputs: [],
    lastUpdatedAt: new Date().toISOString(),
  }
}

function migrateState(raw: Record<string, unknown>): WorkspaceState {
  const state = raw as unknown as WorkspaceState
  if (state.version !== STATE_VERSION) {
    // 简单迁移：保留已知字段，重置版本
    state.version = STATE_VERSION
  }
  return state
}

export async function loadWorkspaceState(workspaceId: string): Promise<WorkspaceState | null> {
  try {
    const [row] = await db
      .select()
      .from(workspaceStates)
      .where(eq(workspaceStates.workspaceId, workspaceId))
      .limit(1)
    if (!row?.state) return null
    const state = migrateState(row.state as Record<string, unknown>)
    state.workspaceId = workspaceId // 确保一致性
    return state
  } catch (err: any) {
    logger.warn({ workspaceId, err: err?.message }, 'Failed to load workspace state')
    return null
  }
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  try {
    const updated: WorkspaceState = {
      ...state,
      lastUpdatedAt: new Date().toISOString(),
    }
    await db
      .insert(workspaceStates)
      .values({
        workspaceId: state.workspaceId,
        state: updated as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceStates.workspaceId,
        set: {
          state: updated as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      })
  } catch (err: any) {
    logger.warn({ workspaceId: state.workspaceId, err: err?.message }, 'Failed to save workspace state')
  }
}

/**
 * 记录 Agent 产出到 Workspace 状态。
 * 如果状态不存在会自动创建。
 */
export async function recordAgentOutput(
  workspaceId: string,
  agentId: string,
  agentName: string,
  role: string,
  content: string,
): Promise<void> {
  const state = (await loadWorkspaceState(workspaceId)) ?? createInitialWorkspaceState(workspaceId, '')
  state.agentOutputs.push({
    agentId,
    agentName,
    role,
    content: content.slice(0, 2000),
    timestamp: new Date().toISOString(),
  })
  // 只保留最近 20 条
  if (state.agentOutputs.length > 20) {
    state.agentOutputs = state.agentOutputs.slice(-20)
  }
  await saveWorkspaceState(state)
}

/**
 * 更新 Workspace 阶段和计划。
 */
export async function updateWorkspacePhase(
  workspaceId: string,
  phase: WorkspaceState['currentPhase'],
  plan?: string,
): Promise<void> {
  const state = (await loadWorkspaceState(workspaceId)) ?? createInitialWorkspaceState(workspaceId, '')
  state.currentPhase = phase
  if (plan !== undefined) state.plan = plan
  await saveWorkspaceState(state)
}

/**
 * 为 Orchestrator 构建包含 Workspace 状态的上下文提示。
 * 让 Orchestrator 了解当前进展、已完成任务和待解决问题。
 */
export async function buildWorkspaceStateContext(workspaceId: string): Promise<string> {
  const state = await loadWorkspaceState(workspaceId)
  if (!state) return ''

  const sections: string[] = []
  sections.push(`【Workspace 状态】当前阶段：${state.currentPhase}`)
  if (state.goal) sections.push(`协作目标：${state.goal}`)
  if (state.plan) sections.push(`\n当前计划：\n${state.plan}`)

  if (state.completedTasks.length > 0) {
    sections.push(`\n已完成任务：`)
    for (const t of state.completedTasks) {
      sections.push(`- ${t.agentName}(${t.title}) [${t.status}]${t.summary ? `：${t.summary}` : ''}`)
    }
  }

  if (state.pendingIssues.length > 0) {
    sections.push(`\n待解决问题：`)
    for (const issue of state.pendingIssues) {
      sections.push(`- ${issue}`)
    }
  }

  if (state.agentOutputs.length > 0) {
    sections.push(`\n各 Agent 最新产出：`)
    for (const out of state.agentOutputs.slice(-5)) {
      sections.push(`- ${out.agentName}(${out.role}) @ ${out.timestamp}：${out.content.slice(0, 200)}`)
    }
  }

  return sections.join('\n')
}
