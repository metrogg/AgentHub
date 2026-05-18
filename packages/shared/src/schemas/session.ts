import { z } from 'zod'

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['direct', 'group']),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Session = z.infer<typeof sessionSchema>

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['direct', 'group']).default('direct'),
  agentIds: z.array(z.string()).default([]),
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>
