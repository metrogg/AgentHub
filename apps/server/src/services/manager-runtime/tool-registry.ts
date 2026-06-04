import { db, eq, workspaceAgents, workspaceTasks, orchestratorRuns } from '@agenthub/db'
import { roomService } from '../rooms/room-service'
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
}

const executors = new Map<string, ToolExecutor>()

// ─── Worker Management ───────────────────────────────────────────────

executors.set('controller.workers.list', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) {
    return { callId: call.id, toolName: call.name, success: false, output: 'No workspaceId in context' }
  }
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
  const summary = agents.map((a) => `${a.name} (${a.roleType || 'unknown'})`).join('\n')
  return {
    callId: call.id,
    toolName: call.name,
    success: true,
    output: agents.length ? `Found ${agents.length} workers:\n${summary}` : 'No workers found.',
    metadata: { count: agents.length },
  }
})

// ─── Task Management ─────────────────────────────────────────────────

executors.set('controller.runs.list', async (call, ctx) => {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) {
    return { callId: call.id, toolName: call.name, success: false, output: 'No workspaceId in context' }
  }
  const runs = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.workspaceId, workspaceId))
  const summary = runs.map((r) => `${r.id.slice(0, 8)} status=${r.status}`).join('\n')
  return {
    callId: call.id,
    toolName: call.name,
    success: true,
    output: runs.length ? `Found ${runs.length} runs:\n${summary}` : 'No runs found.',
    metadata: { count: runs.length },
  }
})

executors.set('controller.tasks.list', async (call, ctx) => {
  const runId = ctx.runId || (call.arguments.runId as string)
  if (!runId) {
    return { callId: call.id, toolName: call.name, success: false, output: 'No runId in context' }
  }
  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.runId, runId))
  const summary = tasks.map((t) => `${t.title || t.id.slice(0, 8)} status=${t.status}`).join('\n')
  return {
    callId: call.id,
    toolName: call.name,
    success: true,
    output: tasks.length ? `Found ${tasks.length} tasks:\n${summary}` : 'No tasks found.',
    metadata: { count: tasks.length },
  }
})

// ─── Room / Channel Management ───────────────────────────────────────

executors.set('controller.rooms.create', async (call, ctx) => {
  try {
    const room = await roomService.createRoom({
      ownerId: ctx.ownerId,
      kind: normalizeRoomKind(call.arguments.kind),
      title: (call.arguments.title as string) || 'New Room',
      workspaceId: ctx.workspaceId || undefined,
    })
    return {
      callId: call.id,
      toolName: call.name,
      success: true,
      output: `Room created: ${room.id}`,
      metadata: { roomId: room.id },
    }
  } catch (error) {
    return { callId: call.id, toolName: call.name, success: false, output: `Failed: ${error}` }
  }
})

executors.set('controller.rooms.events.create', async (call, ctx) => {
  const roomId = (call.arguments.roomId as string) || ctx.roomId
  const body = call.arguments.body as string
  if (!roomId || !body) {
    return { callId: call.id, toolName: call.name, success: false, output: 'Missing roomId or body' }
  }
  try {
    const event = await roomService.appendTimelineEvent({
      roomId,
      senderType: 'manager',
      type: 'manager.message',
      body,
    })
    return {
      callId: call.id,
      toolName: call.name,
      success: true,
      output: `Message sent to room ${roomId}, event ${event.id}`,
      metadata: { eventId: event.id },
    }
  } catch (error) {
    return { callId: call.id, toolName: call.name, success: false, output: `Failed: ${error}` }
  }
})

// ─── Artifact Management ─────────────────────────────────────────────

executors.set('controller.artifacts.list', async (call, ctx) => {
  const taskId = call.arguments.taskId as string
  if (!taskId) {
    return { callId: call.id, toolName: call.name, success: false, output: 'Missing taskId parameter' }
  }
  // Import dynamically to avoid circular deps
  const { registerTaskArtifact } = await import('../orchestrator/artifact-store')
  return {
    callId: call.id,
    toolName: call.name,
    success: true,
    output: `Artifact lookup for task ${taskId} — use ArtifactStore API directly.`,
  }
})

// ─── Generic fallback ────────────────────────────────────────────────

const FALLBACK_EXECUTOR: ToolExecutor = async (call) => ({
  callId: call.id,
  toolName: call.name,
  success: false,
  output: `Tool "${call.name}" is recognized but has no executor registered yet. This is a skill definition only.`,
})

// ─── Public API ──────────────────────────────────────────────────────

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

function normalizeRoomKind(value: unknown): RoomKind {
  return value === 'group' ||
    value === 'manager_dm' ||
    value === 'task' ||
    value === 'direct' ||
    value === 'human_intervention'
    ? value
    : 'group'
}
