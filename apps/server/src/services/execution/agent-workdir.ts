import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AgentWorkdirInput {
  projectPath?: string | null
  runId: string
  taskId: string
  agentId: string
  agentName?: string | null
  sandboxPolicy: 'workspace-write' | 'danger-full-access'
}

export interface AgentWorkdir {
  projectPath: string
  executionPath: string
  relativePath: string
}

/**
 * 为写入型 Agent 准备一个通用执行目录。
 *
 * 这个目录只用于当前任务的产物和中间文件，不再镜像用户项目。
 * Agent 需要读取原项目时，通过 prompt 中的 originalProjectPath 显式访问；
 * 这样可以避免搜索重复、上下文污染，以及把运行目录误当真实仓库根。
 *
 * Current default: stable per-agent execution directories under .agenthub/workdirs.
 * Git branch/worktree isolation is not part of the default execution contract.
 */
export function prepareAgentWorkdir(input: AgentWorkdirInput): AgentWorkdir | null {
  const projectPath = input.projectPath?.trim()
  if (!projectPath) return null

  const relativePath = [
    '.agenthub',
    'workdirs',
    safePathSegment(input.runId),
    safePathSegment(input.agentName || input.agentId),
    safePathSegment(input.taskId),
  ].join('/')
  const executionPath = resolve(projectPath, relativePath)
  mkdirSync(executionPath, { recursive: true })

  return {
    projectPath,
    executionPath,
    relativePath,
  }
}

function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown'
}
