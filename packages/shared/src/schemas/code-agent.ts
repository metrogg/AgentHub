import { z } from 'zod'

/**
 * CodeAgent 运行元数据。
 * 前后端共用，避免字段漂移。
 */
export const codeAgentRunMetadataSchema = z.object({
  type: z.literal('code-agent-run'),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']),
  runtime: z.enum(['codex', 'claude-code', 'opencode', 'gemini']),
  command: z.string(),
  cwd: z.string().optional(),
  durationMs: z.number(),
  exitCode: z.number(),
  commands: z.array(z.object({
    id: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
  })),
  files: z.array(z.object({
    path: z.string(),
    status: z.enum(['created', 'modified', 'deleted', 'renamed', 'untracked']),
    diff: z.string().optional(),
  })),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    label: z.string(),
    target: z.string().optional(),
    detail: z.string().optional(),
  })).optional(),
  artifacts: z.array(z.any()).optional(),
  logs: z.array(z.object({
    id: z.string(),
    stream: z.enum(['stdout', 'stderr', 'event']),
    text: z.string(),
  })).optional(),
  steps: z.array(z.object({
    id: z.string(),
    kind: z.enum(['status', 'tool', 'command', 'file', 'log']),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']),
    title: z.string(),
    subtitle: z.string().optional(),
    detail: z.string().optional(),
    toolName: z.string().optional(),
    command: z.string().optional(),
    path: z.string().optional(),
    fileStatus: z.enum(['created', 'modified', 'deleted', 'renamed', 'untracked']).optional(),
    stream: z.enum(['stdout', 'stderr', 'event']).optional(),
    createdAt: z.number().optional(),
  })).optional(),
  diagnostics: z.string().optional(),
})

export type CodeAgentRunMetadata = z.infer<typeof codeAgentRunMetadataSchema>
