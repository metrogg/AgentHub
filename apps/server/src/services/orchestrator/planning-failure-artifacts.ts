import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'

export type RecoveredPlanningArtifact = {
  id: string
  type: 'file'
  title: string
  path: string
  status: 'created'
  mimeType: string
  size: number
  sourcePath: string
}

const recoverableExtensions = new Set([
  '.doc',
  '.docx',
  '.htm',
  '.html',
  '.md',
  '.pdf',
  '.ppt',
  '.pptx',
  '.txt',
  '.xls',
  '.xlsx',
])

export function extractPlanningFailureArtifacts(
  text: string,
  workspaceProjectPath?: string | null,
): RecoveredPlanningArtifact[] {
  if (!text.trim() || !workspaceProjectPath?.trim()) return []

  const workspaceRoot = resolve(workspaceProjectPath)
  const candidates = extractFilePathCandidates(text)
  const seen = new Set<string>()
  const artifacts: RecoveredPlanningArtifact[] = []

  for (const candidate of candidates) {
    const absolutePath = resolve(candidate)
    const normalizedKey = absolutePath.toLowerCase()
    if (seen.has(normalizedKey)) continue
    seen.add(normalizedKey)

    if (!isPathInside(absolutePath, workspaceRoot)) continue
    if (!existsSync(absolutePath)) continue

    const stats = statSync(absolutePath)
    if (!stats.isFile()) continue

    const ext = extname(absolutePath).toLowerCase()
    if (!recoverableExtensions.has(ext)) continue

    const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, '/')
    artifacts.push({
      id: `planning-file-${hashPath(relativePath)}`,
      type: 'file',
      title: basename(absolutePath),
      path: relativePath,
      status: 'created',
      mimeType: mimeTypeFromExtension(ext),
      size: stats.size,
      sourcePath: absolutePath,
    })
  }

  return artifacts
}

export function buildPlanningFailureArtifactMetadata(
  artifacts: RecoveredPlanningArtifact[],
  runId: string,
  workspaceId?: string,
) {
  if (!artifacts.length) return {}

  return {
    artifacts,
    file_card: {
      files: artifacts.map((artifact) => ({
        fileName: artifact.title,
        filePath: artifact.path,
        fileSize: artifact.size,
        runId,
        workspaceId,
      })),
    },
    delivery_report: {
      status: 'partial',
      runId,
      files: artifacts.map((artifact) => ({
        name: artifact.title,
        size: artifact.size,
        type: extensionLabel(artifact.path),
      })),
      checklist: [{ item: 'Recovered generated file from planning output', done: true }],
    },
    recoveredPlanningArtifacts: true,
  }
}

function extractFilePathCandidates(text: string) {
  const values = new Set<string>()
  const quotedPathPattern =
    /[`'"]((?:[A-Za-z]:\\|\/)[^`'"]+\.(?:docx?|pptx?|xlsx?|pdf|html?|md|txt))[`'"]/gi
  const rawPathPattern =
    /(?:[A-Za-z]:\\|\/)[^\s`"'<>|]+\.(?:docx?|pptx?|xlsx?|pdf|html?|md|txt)/gi

  for (const match of text.matchAll(quotedPathPattern)) {
    const value = sanitizeCandidate(match[1])
    if (value) values.add(value)
  }
  for (const match of text.matchAll(rawPathPattern)) {
    const value = sanitizeCandidate(match[0])
    if (value) values.add(value)
  }

  return Array.from(values)
}

function sanitizeCandidate(value?: string) {
  const trimmed = value?.trim().replace(/[),.;\uFF0C\u3002\uFF1B\u3001]+$/g, '') ?? ''
  return trimmed && isAbsolute(trimmed) ? trimmed : null
}

function isPathInside(path: string, root: string) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function hashPath(value: string) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function extensionLabel(path: string) {
  return extname(path).replace(/^\./, '').toLowerCase() || 'file'
}

function mimeTypeFromExtension(ext: string) {
  const map: Record<string, string> = {
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return map[ext] ?? 'application/octet-stream'
}
