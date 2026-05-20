import { z } from 'zod'

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['claude', 'openai', 'gemini', 'mcp', 'custom']),
  model: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})
export type Agent = z.infer<typeof agentSchema>
