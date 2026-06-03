import { z } from 'zod'

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  senderId: z.string(),
  senderType: z.enum(['user', 'agent', 'system']),
  type: z.enum(['text', 'markdown', 'code', 'diff', 'image', 'file', 'task_card', 'task_board']),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
})
export type Message = z.infer<typeof messageSchema>

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  type: z.enum(['text', 'markdown', 'image', 'file']).default('text'),
  mentions: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
})
export type SendMessageInput = z.infer<typeof sendMessageSchema>
