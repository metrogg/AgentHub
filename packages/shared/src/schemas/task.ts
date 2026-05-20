import { z } from 'zod'

export const taskSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentId: z.string().nullable(),
  agentId: z.string().nullable(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  result: z.unknown().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Task = z.infer<typeof taskSchema>
