import { statSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import { HTTPException } from 'hono/http-exception'
import { db, workspaces, eq } from '@agenthub/db'

export function cleanProjectPath(value?: string | null) {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return normalize(isAbsolute(trimmed) ? trimmed : resolve(trimmed))
}

export function ensureProjectDirectory(value?: string | null) {
  const projectPath = cleanProjectPath(value)
  if (!projectPath) return null
  try {
    if (statSync(projectPath).isDirectory()) return projectPath
  } catch {
    // Fall through to a consistent API error below.
  }
  throw new HTTPException(400, { message: '项目文件夹不存在或不是目录' })
}

export function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
}

export function projectPathKey(value?: string | null) {
  const cleaned = cleanProjectPath(value)
  if (!cleaned) return ''
  const key = cleaned.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

export async function findWorkspaceByProjectPath(ownerId: string, projectPath: string) {
  const key = projectPathKey(projectPath)
  const list = await db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId))
  return list.find((workspace) => projectPathKey(workspace.projectPath) === key) ?? null
}

export function touchWorkspace(id: string) {
  return db.update(workspaces).set({ updatedAt: new Date() }).where(eq(workspaces.id, id))
}
