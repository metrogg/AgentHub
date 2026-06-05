import type { CodeAgentRunMetadata } from '@agenthub/shared'
import type { WorkspaceAgent } from './api'

/**
 * Agent 运行时类型的中文/英文显示名。
 * 替代 Thread.tsx、AgentConfigPage.tsx、AgentWorldPage.tsx 中的重复 runtimeLabel。
 */
export function runtimeLabel(value: WorkspaceAgent['runtimeType']): string {
  const map: Record<string, string> = {
    'code-agent': 'Code Worker',
    llm: 'LLM Agent (deprecated)',
  }
  return map[value] ?? value
}

/**
 * Code Agent 运行时的显示名（Codex、Claude Code 等）。
 * 替代 Thread.tsx 中的 runtimeLabel（针对 code-agent-run 场景）。
 */
export function codeAgentRuntimeLabel(runtime: CodeAgentRunMetadata['runtime']): string {
  if (runtime === 'claude-code') return 'Claude Code'
  if (runtime === 'opencode') return 'OpenCode'
  if (runtime === 'gemini') return 'Gemini CLI'
  if (runtime === 'openclaw') return 'OpenClaw'
  return 'Codex'
}

/**
 * Code Agent 类型的显示名。
 * 替代 AgentWorldPage.tsx 中的 codeAgentLabel。
 */
export function codeAgentLabel(value: NonNullable<WorkspaceAgent['codeAgentType']>): string {
  const map: Record<NonNullable<WorkspaceAgent['codeAgentType']>, string> = {
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
    openclaw: 'OpenClaw',
  }
  return map[value] ?? value
}

/**
 * 沙箱策略的中文显示名。
 * 替代 AgentConfigPage.tsx、AgentWorldPage.tsx 中的重复 sandboxLabel。
 */
export function sandboxLabel(value: WorkspaceAgent['sandboxPolicy']): string {
  const map: Record<WorkspaceAgent['sandboxPolicy'], string> = {
    'workspace-write': '工作区写入',
    'danger-full-access': '完全访问',
  }
  return map[value] ?? value
}
