export type TaskBoardTaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type TaskBoardRunStatus =
  | 'planning'
  | 'running'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TaskBoardPhaseStatus = 'pending' | 'active' | 'completed'

export interface TaskBoardPhaseStatusInput {
  id: string
  title: string
  purpose: string
  taskIds: string[]
  status: TaskBoardPhaseStatus
}

export interface TaskBoardTaskStatusInput {
  id: string
  status: string | null | undefined
}

const TASK_BOARD_TASK_STATUSES = new Set<TaskBoardTaskStatus>([
  'pending',
  'assigned',
  'running',
  'done',
  'failed',
  'blocked',
  'cancelled',
])

const TASK_THREAD_TO_TASK_BOARD_STATUS: Record<string, TaskBoardTaskStatus> = {
  prepared: 'pending',
  assigned: 'assigned',
  active: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

const TASK_BOARD_RUN_STATUSES = new Set<TaskBoardRunStatus>([
  'planning',
  'running',
  'synthesizing',
  'completed',
  'failed',
  'cancelled',
])

const ACTIVE_TASK_BOARD_TASK_STATUSES = new Set<string>(['assigned', 'running', 'blocked'])
const TERMINAL_TASK_BOARD_TASK_STATUSES = new Set<string>(['done', 'failed', 'cancelled'])
const TERMINAL_TASK_BOARD_RUN_STATUSES = new Set<unknown>(['completed', 'failed', 'cancelled'])

export function normalizeTaskBoardTaskStatus(
  value: string | null | undefined,
): TaskBoardTaskStatus | null {
  return TASK_BOARD_TASK_STATUSES.has(value as TaskBoardTaskStatus)
    ? (value as TaskBoardTaskStatus)
    : null
}

export function normalizeTaskBoardTaskStatusFromTaskThread(
  value: string | null | undefined,
): TaskBoardTaskStatus | null {
  return value ? TASK_THREAD_TO_TASK_BOARD_STATUS[value] ?? null : null
}

export function normalizeTaskBoardRunStatus(
  value: string | null | undefined,
): TaskBoardRunStatus | null {
  return TASK_BOARD_RUN_STATUSES.has(value as TaskBoardRunStatus)
    ? (value as TaskBoardRunStatus)
    : null
}

export function applyTaskBoardSnapshotStatuses<TPhase extends TaskBoardPhaseStatusInput>(
  phases: TPhase[],
  tasks: TaskBoardTaskStatusInput[],
): Array<Omit<TPhase, 'status'> & { status: TaskBoardPhaseStatus }> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  return phases.map((phase) => {
    const phaseTasks = phase.taskIds
      .map((id) => tasksById.get(id))
      .filter((task): task is TaskBoardTaskStatusInput => Boolean(task))
    if (!phaseTasks.length) return { ...phase, status: 'pending' }
    if (phaseTasks.some((task) => ACTIVE_TASK_BOARD_TASK_STATUSES.has(String(task.status)))) {
      return { ...phase, status: 'active' }
    }
    if (phaseTasks.every((task) => TERMINAL_TASK_BOARD_TASK_STATUSES.has(String(task.status)))) {
      return { ...phase, status: 'completed' }
    }
    return { ...phase, status: 'pending' }
  })
}

export function isTerminalTaskBoardSnapshotStatus(status: unknown) {
  return TERMINAL_TASK_BOARD_RUN_STATUSES.has(status)
}
