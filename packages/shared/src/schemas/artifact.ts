import { z } from 'zod'

const artifactBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  createdAt: z.string().optional(),
})

export const diffArtifactSchema = artifactBaseSchema.extend({
  type: z.literal('diff'),
  filePath: z.string(),
  status: z.enum(['created', 'modified', 'deleted', 'renamed', 'untracked']).optional(),
  language: z.string().optional(),
  diff: z.string(),
})

export const previewArtifactSchema = artifactBaseSchema.extend({
  type: z.literal('preview'),
  url: z.string(),
  previewKind: z.enum(['dev-server', 'static-html', 'iframe']).default('iframe'),
})

export const fileArtifactSchema = artifactBaseSchema.extend({
  type: z.literal('file'),
  path: z.string(),
  status: z.enum(['created', 'modified', 'deleted', 'renamed', 'untracked']).optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
})

export const deployArtifactSchema = artifactBaseSchema.extend({
  type: z.literal('deploy'),
  provider: z.enum(['vercel', 'static', 'unknown']),
  status: z.enum(['pending', 'running', 'ready', 'failed']),
  url: z.string().optional(),
  logs: z.string().optional(),
})

export const agentArtifactSchema = z.discriminatedUnion('type', [
  diffArtifactSchema,
  previewArtifactSchema,
  fileArtifactSchema,
  deployArtifactSchema,
])

export type DiffArtifact = z.infer<typeof diffArtifactSchema>
export type PreviewArtifact = z.infer<typeof previewArtifactSchema>
export type FileArtifact = z.infer<typeof fileArtifactSchema>
export type DeployArtifact = z.infer<typeof deployArtifactSchema>
export type AgentArtifact = z.infer<typeof agentArtifactSchema>
