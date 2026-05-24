import { z } from 'zod'

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['direct', 'group']),
  ownerId: z.string(),
  workspaceId: z.string().nullable().optional(),
  workspaceAgentId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Session = z.infer<typeof sessionSchema>

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['direct', 'group']).default('direct'),
  agentIds: z.array(z.string()).default([]),
  workspaceId: z.string().nullable().optional(),
  workspaceAgentId: z.string().nullable().optional(),
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>
