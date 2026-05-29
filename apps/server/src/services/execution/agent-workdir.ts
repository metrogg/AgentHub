import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AgentWorkdirInput {
  projectPath?: string | null
  runId: string
  taskId: string
  agentId: string
  agentName?: string | null
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface AgentWorkdir {
  projectPath: string
  executionPath: string
  relativePath: string
}

/**
 * 为写入型 Agent 准备一个通用执行目录。
 * 现阶段不再强依赖 Git 分支/worktree，先保证每个成员有稳定、可预览、可追踪的工作目录。
 */
export function prepareAgentWorkdir(input: AgentWorkdirInput): AgentWorkdir | null {
  const projectPath = input.projectPath?.trim()
  if (!projectPath || input.sandboxPolicy === 'read-only') return null

  const relativePath = [
    '.agenthub',
    'workdirs',
    safePathSegment(input.runId),
    safePathSegment(input.agentName || input.agentId),
    safePathSegment(input.taskId),
  ].join('/')
  const executionPath = resolve(projectPath, relativePath)
  mkdirSync(executionPath, { recursive: true })
  seedWorkdir(projectPath, executionPath)

  return {
    projectPath,
    executionPath,
    relativePath,
  }
}

function seedWorkdir(projectPath: string, executionPath: string) {
  try {
    mirrorDirectory(executionPath, projectPath, executionPath)
  } catch {
    // 复制只是让 Agent 工作目录更接近真实项目；失败时仍允许 Agent 在空目录中产出。
  }
}

function mirrorDirectory(targetRoot: string, sourceDir: string, targetDir: string) {
  const entries = readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldSkipMirrorEntry(entry.name)) continue
    const sourcePath = resolve(sourceDir, entry.name)
    const targetPath = resolve(targetDir, entry.name)
    if (sourcePath === targetRoot || sourcePath.startsWith(`${targetRoot}\\`) || sourcePath.startsWith(`${targetRoot}/`)) {
      continue
    }
    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true })
      mirrorDirectory(targetRoot, sourcePath, targetPath)
      continue
    }
    if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath)
    }
  }
}

function shouldSkipMirrorEntry(name: string) {
  const lower = name.toLowerCase()
  return [
    '.agenthub',
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.vite',
    'coverage',
    '.turbo',
    '.cache',
    '.idea',
    '.vscode',
  ].includes(lower)
}

function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown'
}
