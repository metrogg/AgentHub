import { db, eq, and, workspaceAgents, workspaceTasks, orchestratorRuns, artifacts } from '@agenthub/db'
import { roomService } from '../rooms/room-service'
import { workerController } from '../orchestrator/worker-controller'
import { runController } from '../orchestrator/run-controller'
import type { RoomKind } from '../rooms/types'
import type { ManagerToolCall, ManagerToolResult } from './types'

// ─── Tool Registry ───────────────────────────────────────────────────
// Maps Manager tool calls to actual Controller API / service calls.
// Aligned with HiClaw's pattern: LLM calls a tool, tool executes a
// Controller API, result goes back to the LLM.

export type ToolExecutor = (
  call: ManagerToolCall,
  context: ToolExecutionContext,
) => Promise<ManagerToolResult>

export interface ToolExecutionContext {
  roomId: string
  workspaceId?: string | null
  ownerId: string
  runId?: string | null
  groupSessionId?: string | null
}

const executors = new Map<string, ToolExecutor>()

// ═══════════════════════════════════════════════════════════════════════
// Worker Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.workers.list', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) {
    return error(call, 'No workspaceId in context')
  }
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
  const summary = agents
    .map((a) => `- ${a.name} (id=${a.id}, role=${a.roleType || 'unknown'})`)
    .join('\n')
  return ok(call, agents.length ? `Found ${agents.length} workers:\n${summary}` : 'No workers found.', {
    count: agents.length,
  })
})

executors.set('controller.workers.wake', async (call) => {
  const workerId = call.arguments.workerId as string
  if (!workerId) return error(call, 'Missing workerId parameter')
  try {
    const woke = await workerController.wakeWorker(workerId)
    return ok(call, woke ? `Worker ${workerId} woken up.` : `Worker ${workerId} was already awake or not found.`, {
      woke,
    })
  } catch (e) {
    return error(call, `Failed to wake worker: ${e}`)
  }
})

executors.set('controller.workers.stop', async (call) => {
  const workerId = call.arguments.workerId as string
  if (!workerId) return error(call, 'Missing workerId parameter')
  try {
    await workerController.releaseWorker(workerId, { reason: 'Manager requested stop' })
    return ok(call, `Worker ${workerId} stopped and lease released.`)
  } catch (e) {
    return error(call, `Failed to stop worker: ${e}`)
  }
})

executors.set('controller.workers.idle-stop', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) return error(call, 'No workspaceId in context')
  try {
    const result = await workerController.tryIdleStop(workspaceId)
    return ok(
      call,
      result.stoppedCount > 0
        ? `Stopped ${result.stoppedCount} idle workers: ${result.stoppedIds.join(', ')}`
        : 'No idle workers to stop.',
      { stoppedCount: result.stoppedCount, stoppedIds: result.stoppedIds },
    )
  } catch (e) {
    return error(call, `Failed to idle-stop workers: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Run Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.runs.list', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) return error(call, 'No workspaceId in context')
  const runs = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.workspaceId, workspaceId))
  const summary = runs
    .map((r) => `- ${r.id.slice(0, 8)} status=${r.status} session=${r.groupSessionId.slice(0, 8)}`)
    .join('\n')
  return ok(call, runs.length ? `Found ${runs.length} runs:\n${summary}` : 'No runs found.', { count: runs.length })
})

executors.set('controller.runs.create', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  const groupSessionId = ctx.groupSessionId
  if (!workspaceId || !groupSessionId) return error(call, 'Missing workspaceId or groupSessionId')
  const goal = call.arguments.goal as string
  if (!goal) return error(call, 'Missing goal parameter')
  try {
    const runCtx = await runController.start({
      workspaceId,
      groupSessionId,
      goal,
      actor: { id: 'manager', name: 'Manager' },
    })
    return ok(call, `Run created: ${runCtx.runId}`, { runId: runCtx.runId })
  } catch (e) {
    return error(call, `Failed to create run: ${e}`)
  }
})

executors.set('controller.runs.reconcile', async (call) => {
  const runId = call.arguments.runId as string
  if (!runId) return error(call, 'Missing runId parameter')
  try {
    const snapshot = await runController.reconcile({
      runId,
      workspaceId: call.arguments.workspaceId as string || '',
      groupSessionId: call.arguments.groupSessionId as string || '',
    })
    const summary = [
      `Run ${runId}: ${snapshot.run?.status || 'unknown'}`,
      `Tasks: ${snapshot.counts.totalTasks} total, ${JSON.stringify(snapshot.counts.tasksByStatus)}`,
      `Workers: ${snapshot.counts.totalWorkerInstances} total, ${JSON.stringify(snapshot.counts.workerInstancesByState)}`,
      `Artifacts: ${snapshot.counts.totalArtifacts}`,
    ].join('\n')
    return ok(call, summary, { snapshot })
  } catch (e) {
    return error(call, `Failed to reconcile run: ${e}`)
  }
})

executors.set('controller.runs.cancel', async (call) => {
  const runId = call.arguments.runId as string
  if (!runId) return error(call, 'Missing runId parameter')
  const reason = (call.arguments.reason as string) || 'Manager requested cancellation'
  try {
    await runController.cancel(
      { runId, workspaceId: call.arguments.workspaceId as string || '', groupSessionId: '' },
      { reason },
    )
    return ok(call, `Run ${runId} cancelled. Reason: ${reason}`)
  } catch (e) {
    return error(call, `Failed to cancel run: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Task Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.tasks.list', async (call, ctx) => {
  const runId = ctx.runId || (call.arguments.runId as string)
  if (!runId) return error(call, 'No runId in context')
  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.runId, runId))
  const summary = tasks
    .map((t) => `- ${t.title || t.id.slice(0, 8)} status=${t.status} agent=${t.agentId || 'unassigned'}`)
    .join('\n')
  return ok(call, tasks.length ? `Found ${tasks.length} tasks:\n${summary}` : 'No tasks found.', {
    count: tasks.length,
  })
})

executors.set('controller.tasks.status', async (call) => {
  const taskId = call.arguments.taskId as string
  if (!taskId) return error(call, 'Missing taskId parameter')
  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, taskId))
  if (!tasks.length) return error(call, `Task ${taskId} not found`)
  const t = tasks[0]!
  const summary = [
    `Task: ${t.title || t.id}`,
    `Status: ${t.status}`,
    `Agent: ${t.agentId || 'unassigned'}`,
    `Progress: ${t.progressPercent ?? 0}%`,
    t.errorLog ? `Error: ${t.errorLog}` : '',
    t.startedAt ? `Started: ${t.startedAt}` : '',
    t.completedAt ? `Completed: ${t.completedAt}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return ok(call, summary, { task: t })
})

executors.set('controller.tasks.complete', async (call) => {
  const taskId = call.arguments.taskId as string
  const runId = call.arguments.runId as string
  if (!taskId || !runId) return error(call, 'Missing taskId or runId')
  try {
    await runController.markTaskCompleted(
      { runId, workspaceId: '', groupSessionId: '' },
      {
        taskId,
        title: call.arguments.title as string | undefined,
        progressStatus: 'completed',
      },
    )
    return ok(call, `Task ${taskId} marked as completed.`)
  } catch (e) {
    return error(call, `Failed to complete task: ${e}`)
  }
})

executors.set('controller.tasks.retry', async (call) => {
  const taskId = call.arguments.taskId as string
  const runId = call.arguments.runId as string
  if (!taskId || !runId) return error(call, 'Missing taskId or runId')
  try {
    // Reset task to pending for re-execution
    await runController.markTaskFailed(
      { runId, workspaceId: '', groupSessionId: '' },
      { taskId, error: 'Manager requested retry', progressStatus: 'retry_requested' },
    )
    return ok(call, `Task ${taskId} reset for retry.`)
  } catch (e) {
    return error(call, `Failed to retry task: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Room / Channel Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.rooms.create', async (call, ctx) => {
  try {
    const room = await roomService.createRoom({
      ownerId: ctx.ownerId,
      kind: normalizeRoomKind(call.arguments.kind),
      title: (call.arguments.title as string) || 'New Room',
      workspaceId: ctx.workspaceId || undefined,
    })
    return ok(call, `Room created: ${room.id}`, { roomId: room.id })
  } catch (e) {
    return error(call, `Failed to create room: ${e}`)
  }
})

executors.set('controller.rooms.events.create', async (call, ctx) => {
  const roomId = (call.arguments.roomId as string) || ctx.roomId
  const body = call.arguments.body as string
  if (!roomId || !body) return error(call, 'Missing roomId or body')
  try {
    const event = await roomService.appendTimelineEvent({
      roomId,
      senderType: 'manager',
      type: 'manager.message',
      body,
    })
    return ok(call, `Message sent to room ${roomId}, event ${event.id}`, { eventId: event.id })
  } catch (e) {
    return error(call, `Failed to send message: ${e}`)
  }
})

executors.set('controller.rooms.mention', async (call, ctx) => {
  const roomId = (call.arguments.roomId as string) || ctx.roomId
  const targetWorkerId = call.arguments.targetWorkerId as string
  const body = call.arguments.body as string
  if (!roomId || !targetWorkerId || !body) return error(call, 'Missing roomId, targetWorkerId, or body')
  try {
    const participants = await roomService.listRoomParticipants(roomId, ctx.ownerId)
    const target = participants.find((participant) => participant.workspaceAgentId === targetWorkerId)
    if (!target) return error(call, `Worker ${targetWorkerId} is not a participant of room ${roomId}`)
    const event = await roomService.appendMentionTimelineEvent({
      roomId,
      mentionParticipantId: target.id,
      senderType: 'manager',
      type: 'task.assigned',
      body,
    })
    return ok(call, `Mention sent in room ${roomId} to worker ${targetWorkerId}`, { eventId: event.id })
  } catch (e) {
    return error(call, `Failed to send mention: ${e}`)
  }
})

executors.set('controller.rooms.participants.add', async (call) => {
  const roomId = call.arguments.roomId as string
  const workspaceAgentId = call.arguments.workspaceAgentId as string
  if (!roomId || !workspaceAgentId) return error(call, 'Missing roomId or workspaceAgentId')
  try {
    const participant = await roomService.addWorkerParticipant(roomId, workspaceAgentId)
    return ok(call, `Worker ${workspaceAgentId} added to room ${roomId}`, {
      participantId: participant.id,
    })
  } catch (e) {
    return error(call, `Failed to add participant: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Artifact Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.artifacts.list', async (call) => {
  const taskId = call.arguments.taskId as string
  if (!taskId) return error(call, 'Missing taskId parameter')
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
  const summary = rows
    .map((a) => `- ${a.title || a.relativePath || a.id.slice(0, 8)} kind=${a.kind} status=${a.status}`)
    .join('\n')
  return ok(
    call,
    rows.length ? `Found ${rows.length} artifacts for task ${taskId}:\n${summary}` : `No artifacts found for task ${taskId}.`,
    { count: rows.length },
  )
})

executors.set('controller.artifacts.register', async (call, ctx) => {
  const taskId = call.arguments.taskId as string
  const artifactData = call.arguments.artifact as Record<string, unknown>
  if (!taskId || !artifactData) return error(call, 'Missing taskId or artifact data')
  try {
    const { registerTaskArtifact } = await import('../orchestrator/artifact-store')
    const registered = await registerTaskArtifact({
      workspaceId: ctx.workspaceId || '',
      runId: ctx.runId || '',
      taskId,
      artifact: artifactData,
      status: 'registered',
    })
    if (!registered) return error(call, 'Artifact registration returned no artifact')
    return ok(call, `Artifact registered: ${registered.id} (${registered.title || registered.relativePath})`, {
      artifactId: registered.id,
    })
  } catch (e) {
    return error(call, `Failed to register artifact: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Human Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.interventions.create', async (call, ctx) => {
  const roomId = (call.arguments.roomId as string) || ctx.roomId
  const body = call.arguments.body as string
  if (!roomId || !body) return error(call, 'Missing roomId or body')
  try {
    const event = await roomService.appendTimelineEvent({
      roomId,
      senderType: 'manager',
      type: 'system',
      body: `[Human Intervention] ${body}`,
      metadata: { kind: 'human_intervention', sourceEventId: call.arguments.sourceEventId },
    })
    return ok(call, `Intervention recorded in room ${roomId}`, { eventId: event.id })
  } catch (e) {
    return error(call, `Failed to record intervention: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Memory Management
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.memory.create', async (call) => {
  // Memory is stored as room timeline events with kind=memory_entry
  const roomId = call.arguments.roomId as string
  const content = call.arguments.content as string
  if (!roomId || !content) return error(call, 'Missing roomId or content')
  try {
    const event = await roomService.appendTimelineEvent({
      roomId,
      senderType: 'manager',
      type: 'system',
      body: content,
      metadata: { kind: 'memory_entry', category: call.arguments.category || 'general' },
    })
    return ok(call, `Memory entry created: ${event.id}`, { eventId: event.id })
  } catch (e) {
    return error(call, `Failed to create memory entry: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Coordination
// ═══════════════════════════════════════════════════════════════════════

executors.set('controller.coordination.lock', async (call, ctx) => {
  const lockKey = call.arguments.lockKey as string
  const owner = call.arguments.owner as string || 'manager'
  if (!lockKey) return error(call, 'Missing lockKey parameter')
  // Coordination locks are stored as room timeline events
  const roomId = (call.arguments.roomId as string) || ctx.roomId
  if (!roomId) return error(call, 'Missing roomId for coordination lock')
  try {
    const event = await roomService.appendTimelineEvent({
      roomId,
      senderType: 'manager',
      type: 'system',
      body: `Lock acquired: ${lockKey} by ${owner}`,
      metadata: { kind: 'coordination_lock', lockKey, owner, action: 'acquire' },
    })
    return ok(call, `Lock acquired: ${lockKey}`, { eventId: event.id, lockKey })
  } catch (e) {
    return error(call, `Failed to acquire lock: ${e}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Generic fallback
// ═══════════════════════════════════════════════════════════════════════

const FALLBACK_EXECUTOR: ToolExecutor = async (call) => ({
  callId: call.id,
  toolName: call.name,
  success: false,
  output: `Tool "${call.name}" is recognized but has no executor registered yet. This is a skill definition only.`,
})

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Execute a tool call from the Manager LLM.
 * Routes to the appropriate Controller API based on tool name.
 */
export async function executeToolCall(
  call: ManagerToolCall,
  context: ToolExecutionContext,
): Promise<ManagerToolResult> {
  const executor = executors.get(call.name) ?? FALLBACK_EXECUTOR
  return executor(call, context)
}

/**
 * Get all registered tool names.
 */
export function getRegisteredToolNames(): string[] {
  return Array.from(executors.keys())
}

/**
 * Check if a tool has a registered executor.
 */
export function hasExecutor(toolName: string): boolean {
  return executors.has(toolName)
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function ok(call: ManagerToolCall, output: string, metadata?: Record<string, unknown>): ManagerToolResult {
  return { callId: call.id, toolName: call.name, success: true, output, metadata }
}

function error(call: ManagerToolCall, output: string): ManagerToolResult {
  return { callId: call.id, toolName: call.name, success: false, output }
}

function normalizeRoomKind(value: unknown): RoomKind {
  return value === 'group' ||
    value === 'manager_dm' ||
    value === 'task' ||
    value === 'direct' ||
    value === 'human_intervention'
    ? value
    : 'group'
}
