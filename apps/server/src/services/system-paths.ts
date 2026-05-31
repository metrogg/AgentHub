import { mkdirSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { resolve } from 'node:path'

function envValue(key: string) {
  return Bun.env[key]?.trim() || process.env[key]?.trim() || ''
}

export function agentHubUserDataRoot() {
  const configured =
    envValue('AGENTHUB_APP_DATA_DIR') ||
    envValue('AGENTHUB_AGENT_CACHE_DIR') ||
    envValue('AGENTHUB_USER_CACHE_DIR')
  if (configured) {
    const root = resolve(configured, 'AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const bases =
    platform() === 'win32'
      ? [envValue('LOCALAPPDATA'), envValue('APPDATA'), tmpdir()]
      : platform() === 'darwin'
        ? [resolve(homedir(), 'Library', 'Application Support'), tmpdir()]
        : [envValue('XDG_DATA_HOME'), resolve(homedir(), '.local', 'share'), tmpdir()]

  for (const base of bases.filter(Boolean)) {
    const root = resolve(base, 'AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const root = resolve(tmpdir(), 'AgentHub')
  mkdirSync(root, { recursive: true })
  return root
}

export function agentHubUserCacheRoot() {
  const configured =
    envValue('AGENTHUB_AGENT_CACHE_DIR') ||
    envValue('AGENTHUB_USER_CACHE_DIR') ||
    envValue('AGENTHUB_APP_DATA_DIR')
  if (configured) {
    const root = resolve(configured, 'AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const bases =
    platform() === 'win32'
      ? [envValue('LOCALAPPDATA'), envValue('APPDATA'), tmpdir()]
      : platform() === 'darwin'
        ? [resolve(homedir(), 'Library', 'Caches'), tmpdir()]
        : [envValue('XDG_CACHE_HOME'), resolve(homedir(), '.cache'), tmpdir()]

  for (const base of bases.filter(Boolean)) {
    const root = resolve(base, 'AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const root = resolve(tmpdir(), 'AgentHub')
  mkdirSync(root, { recursive: true })
  return root
}

export function defaultWorkspaceStorageRoot() {
  return resolve(agentHubUserDataRoot(), 'workspaces')
}

export function defaultNoProjectExecutionRoot() {
  return resolve(agentHubUserCacheRoot(), 'execution')
}

export function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown'
}

function ensureWritableDir(path: string) {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}
