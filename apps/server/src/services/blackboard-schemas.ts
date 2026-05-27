import { z } from 'zod'

const baseBlackboardValueSchema = z.object({
  schemaType: z.string(),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceAgentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
})

export const factValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('fact'),
  fact: z.string().min(1),
  source: z.enum(['file', 'tool', 'agent', 'user']),
  evidenceRefs: z.array(z.string()).default([]),
})

export const decisionValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('decision'),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
})

export const riskValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('risk'),
  risk: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']),
  mitigation: z.string().optional(),
})

export const artifactRefValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('artifact_ref'),
  artifactId: z.string().min(1),
  artifactKind: z.string().min(1),
  title: z.string().min(1),
  filePath: z.string().optional(),
})

export const diffSummaryValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('diff_summary'),
  changedFiles: z.array(z.string()).default([]),
  branchName: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
})

export const testResultValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('test_result'),
  command: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  outputSummary: z.string().min(1),
})

export const taskOutputValueSchema = baseBlackboardValueSchema.extend({
  schemaType: z.literal('task_output'),
  output: z.string(),
  taskTitle: z.string().min(1),
  agentName: z.string().min(1),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
  summaryData: z.record(z.string(), z.unknown()).optional(),
})

export const blackboardValueSchema = z.discriminatedUnion('schemaType', [
  factValueSchema,
  decisionValueSchema,
  riskValueSchema,
  artifactRefValueSchema,
  diffSummaryValueSchema,
  testResultValueSchema,
  taskOutputValueSchema,
])

export type BlackboardSchemaType = z.infer<typeof blackboardValueSchema>['schemaType']
export type TypedBlackboardValue = z.infer<typeof blackboardValueSchema>

export function parseTypedBlackboardValue(value: unknown): TypedBlackboardValue | null {
  if (!value || typeof value !== 'object' || !('schemaType' in value)) return null
  const result = blackboardValueSchema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : 'value'
    throw new Error(`Invalid blackboard entry: ${path} ${issue?.message ?? 'is invalid'}`)
  }
  return result.data
}
