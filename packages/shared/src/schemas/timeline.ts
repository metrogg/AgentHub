import { z } from 'zod'

export const timelineEventKindSchema = z.enum([
  'message',
  'reasoning',
  'command',
  'file_read',
  'file_change',
  'search',
  'todo_list',
  'subagent',
  'plan',
  'approval',
  'tool',
  'error',
  'turn',
])

export const timelineEventStatusSchema = z.enum([
  'pending',
  'started',
  'running',
  'success',
  'error',
  'cancelled',
  'requires_action',
])

export const timelineRuntimeSchema = z.enum(['claude-code', 'codex', 'opencode', 'gemini', 'llm'])

export const timelineEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string().optional(),
  turnId: z.string(),
  runtime: timelineRuntimeSchema,
  kind: timelineEventKindSchema,
  status: timelineEventStatusSchema,
  title: z.string(),
  summary: z.string().optional(),
  payload: z.record(z.unknown()),
  turnSeq: z.number().int().nonnegative(),
  intraTurnOrder: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type TimelineEventKind = z.infer<typeof timelineEventKindSchema>
export type TimelineEventStatus = z.infer<typeof timelineEventStatusSchema>
export type TimelineRuntime = z.infer<typeof timelineRuntimeSchema>
export type TimelineEvent = z.infer<typeof timelineEventSchema>
