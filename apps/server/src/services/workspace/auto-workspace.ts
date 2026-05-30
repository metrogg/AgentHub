import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { db, eq, settings as settingsTable } from '@agenthub/db'
import { env } from '../../env'
import { logger } from '../../lib/logger'
import { AppError, AppErrorCodes } from '../../lib/error'

type AppSettingsLike = {
  dataPath?: unknown
  workspaceStorageRoot?: unknown
  worktreeRoot?: unknown
}

export type AutoWorkspaceFolder = {
  folderName: string
  projectPath: string
  root: string
}

export async function createAutoWorkspaceFolder(seed?: string | null): Promise<AutoWorkspaceFolder> {
  const root = await ensureWorkspaceStorageRoot()
  const base = `${formatLocalDate()}-${slugify(seed) || 'task'}`

  for (let index = 1; index <= 999; index += 1) {
    const folderName = `${base}-${index}`
    const projectPath = join(root, folderName)
    if (existsSync(projectPath)) continue

    try {
      await mkdir(projectPath)
      return { folderName, projectPath, root }
    } catch (error: any) {
      if (error?.code === 'EEXIST') continue
      throw AppError.fromCode(
        AppErrorCodes.WORKSPACE_CREATE_FAILED,
        '自动创建工作空间文件夹失败',
        { projectPath, reason: error?.message || String(error) },
      )
    }
  }

  throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '自动工作空间目录命名已达上限')
}

async function ensureWorkspaceStorageRoot() {
  const candidates = await workspaceStorageRootCandidates()
  for (const candidate of candidates) {
    if (!isCandidateRootAvailable(candidate)) {
      logger.warn(
        { root: candidate },
        'Workspace storage root unavailable, trying next candidate',
      )
      continue
    }
    try {
      await ensureDirectory(candidate)
      return candidate
    } catch (error: any) {
      logger.warn(
        { root: candidate, err: error?.message || String(error) },
        'Workspace storage root unavailable, trying next candidate',
      )
    }
  }

  throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '默认工作空间存储路径不可用')
}

function isCandidateRootAvailable(candidate: string) {
  if (process.platform !== 'win32') return true
  const { root } = parse(candidate)
  if (!root) return true
  return isDirectory(root)
}

async function ensureDirectory(candidate: string) {
  if (process.platform !== 'win32') {
    await mkdir(candidate, { recursive: true })
    return
  }

  const { root } = parse(candidate)
  if (!root) {
    await mkdir(candidate, { recursive: true })
    return
  }

  let current = root
  for (const segment of candidate.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment)
    if (isDirectory(current)) continue
    try {
      await mkdir(current)
    } catch (error: any) {
      if (error?.code === 'EEXIST' && isDirectory(current)) continue
      throw error
    }
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function workspaceStorageRootCandidates() {
  const appSettings = await readAppSettings()
  const configuredRoot = stringValue(appSettings.workspaceStorageRoot)
  const worktreeRoot = stringValue(appSettings.worktreeRoot)
  const dataPath = stringValue(appSettings.dataPath)
  const envRoot =
    env.AGENTHUB_WORKSPACE_ROOT && env.AGENTHUB_WORKSPACE_ROOT.trim() !== '.'
      ? env.AGENTHUB_WORKSPACE_ROOT
      : null
  const appDataRoot = env.AGENTHUB_APP_DATA_DIR?.trim() || process.cwd()

  return dedupePaths([
    configuredRoot,
    worktreeRoot,
    dataPath ? join(dataPath, 'workspaces') : null,
    envRoot,
    join(appDataRoot, 'workspaces'),
    join(process.cwd(), 'storage', 'workspaces'),
  ])
}

async function readAppSettings(): Promise<AppSettingsLike> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, 'APP_SETTINGS')).limit(1)
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? (parsed as AppSettingsLike) : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function dedupePaths(paths: Array<string | null>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of paths) {
    if (!item) continue
    const normalized = resolve(item)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function slugify(value?: string | null) {
  const normalized = value
    ?.trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return normalized?.slice(0, 36).replace(/-+$/g, '') || ''
}
