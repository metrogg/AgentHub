import { statSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { isAbsolute, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../../lib/logger'
import { AppError, AppErrorCodes } from '../../lib/error'
import { db, workspaces, eq } from '@agenthub/db'
import { workspaceNameFromPath } from '@agenthub/shared'

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
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '项目文件夹不存在或不是目录')
}

export { workspaceNameFromPath }

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

const serviceDir = dirname(fileURLToPath(import.meta.url))
const presetAgenthubDir = resolve(serviceDir, '../../../../../.agenthub')
const presetAgenthubEntries = ['rules', 'skills'] as const

/** @deprecated 不再自动复制内置模板到新工作区；Spec 只作为用户显式创建的协作契约。 */
export function ensureHarnessPresets(projectPath: string | null | undefined) {
  if (!projectPath) return
  const targetDir = resolve(projectPath, '.agenthub')
  if (!existsSync(presetAgenthubDir)) {
    logger.warn('Preset .agenthub/ not found at repo root, skipping copy')
    return
  }
  try {
    mkdirSync(targetDir, { recursive: true })
    const copiedEntries: string[] = []
    const missingEntries: string[] = []

    for (const entry of presetAgenthubEntries) {
      const source = resolve(presetAgenthubDir, entry)
      const target = resolve(targetDir, entry)
      if (!existsSync(source)) {
        missingEntries.push(entry)
        continue
      }
      if (existsSync(target)) continue
      cpSync(source, target, { recursive: true, force: false })
      copiedEntries.push(entry)
    }

    if (copiedEntries.length > 0) {
      logger.info({ targetDir, copiedEntries, missingEntries }, 'Copied preset .agenthub entries to workspace')
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, targetDir }, 'Failed to copy preset .agenthub entries to workspace')
  }
}
