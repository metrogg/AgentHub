import { isTerminalTaskBoardSnapshotStatus } from './task-board-status'

export type RuntimeActivitySnapshotSource = 'task-board' | 'ag-ui' | 'none'

export interface RuntimeActivityAgentActivity {
  sessionId: string
  agentId: string | null
  agentName: string | null
  phase: string
  startedAt: string | null
}

export interface RuntimeActivitySnapshot {
  agentTyping: boolean
  agentActivity: RuntimeActivityAgentActivity | null
  source: RuntimeActivitySnapshotSource
}

export interface RuntimeActivityTaskBoardSnapshot {
  sessionId?: string | null
  status?: unknown
  tasks?: Array<{
    status?: unknown
    agentId?: unknown
    agentName?: unknown
  }> | null
}

export function buildRuntimeActivitySnapshot(input: {
  taskBoardSnapshot?: RuntimeActivityTaskBoardSnapshot | null
  agUiEvents?: unknown[] | null
}): RuntimeActivitySnapshot {
  const taskBoardSnapshot = input.taskBoardSnapshot
  const sessionId = taskBoardSnapshot?.sessionId ?? null

  if (isTerminalTaskBoardSnapshotStatus(taskBoardSnapshot?.status)) {
    return inactiveSnapshot('task-board')
  }

  const runningTask = taskBoardSnapshot?.tasks?.find((task) => task.status === 'running')
  if (runningTask && sessionId) {
    return {
      agentTyping: true,
      agentActivity: {
        sessionId,
        agentId: stringValue(runningTask.agentId),
        agentName: stringValue(runningTask.agentName),
        phase: 'executing',
        startedAt: null,
      },
      source: 'task-board',
    }
  }

  if (Array.isArray(input.agUiEvents) && input.agUiEvents.length && sessionId) {
    const agUiProjection = deriveRuntimeActivityFromAgUiEvents(input.agUiEvents, sessionId)
    if (agUiProjection) return agUiProjection
  }

  if (taskBoardSnapshot?.status === 'planning' && sessionId) {
    return orchestratorActivity(sessionId, 'planning', 'task-board')
  }

  if (taskBoardSnapshot?.status === 'synthesizing' && sessionId) {
    return orchestratorActivity(sessionId, 'synthesizing', 'task-board')
  }

  return inactiveSnapshot('none')
}

export function deriveRuntimeActivityFromAgUiEvents(
  events: unknown[],
  sessionId: string,
): RuntimeActivitySnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = recordValue(events[index])
    if (!event) continue
    const type = stringValue(event.type)
    if (type === 'RUN_FINISHED') return inactiveSnapshot('ag-ui')
    if (type !== 'CUSTOM') continue

    const name = stringValue(event.name)
    const value = recordValue(event.value)
    if (!name || !value) continue

    if (name === 'agenthub.task.status') {
      const status = stringValue(value.status)
      if (status === 'running' || status === 'assigned') {
        return {
          agentTyping: true,
          agentActivity: {
            sessionId,
            agentId: stringValue(value.agentId),
            agentName: stringValue(value.agentName),
            phase: status === 'running' ? 'executing' : 'assigned',
            startedAt: null,
          },
          source: 'ag-ui',
        }
      }
      continue
    }

    if (name === 'agenthub.run.status') {
      const status = stringValue(value.status)
      if (status === 'synthesizing') return orchestratorActivity(sessionId, 'synthesizing', 'ag-ui')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return inactiveSnapshot('ag-ui')
      }
      continue
    }

    if (name === 'agenthub.manager.status') {
      const phase =
        stringValue(value.phase) ??
        stringValue(value.action) ??
        stringValue(value.status)
      if (!phase) continue
      return {
        agentTyping: true,
        agentActivity: {
          sessionId,
          agentId: stringValue(value.actorAgentId),
          agentName: stringValue(value.actorName) ?? 'Orchestrator',
          phase,
          startedAt: null,
        },
        source: 'ag-ui',
      }
    }
  }

  return null
}

function orchestratorActivity(
  sessionId: string,
  phase: 'planning' | 'synthesizing',
  source: 'task-board' | 'ag-ui',
): RuntimeActivitySnapshot {
  return {
    agentTyping: true,
    agentActivity: {
      sessionId,
      agentId: null,
      agentName: 'Orchestrator',
      phase,
      startedAt: null,
    },
    source,
  }
}

function inactiveSnapshot(source: RuntimeActivitySnapshotSource): RuntimeActivitySnapshot {
  return {
    agentTyping: false,
    agentActivity: null,
    source,
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
