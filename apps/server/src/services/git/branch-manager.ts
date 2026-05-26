import { logger } from '../../lib/logger'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface BranchContext {
  branch: string
  originalBranch: string
  projectPath: string
  worktreePath: string
}

export interface MergeResult {
  clean: boolean
  conflictFiles: string[]
  mergedBranch?: string
}

export class GitBranchManager {
  /**
   * 为 Agent 任务准备独立分支 + Git worktree
   * 1. stash 当前未提交变更（保护用户工作区）
   * 2. 从 base branch 创建新分支（不切换）
   * 3. 使用 git worktree add 创建独立工作目录
   */
  async prepareBranch(
    projectPath: string,
    runId: string,
    agentKey: string,
    taskId: string
  ): Promise<BranchContext> {
    const branch = `agenthub/${runId}/${agentKey}/${taskId}`

    const originalBranch = await this.getCurrentBranch(projectPath)
    logger.info({ projectPath, originalBranch, newBranch: branch }, 'Preparing agent branch')

    // 检查是否有未提交变更，有则 stash
    const hasChanges = await this.hasUncommittedChanges(projectPath)
    if (hasChanges) {
      await this.stash(projectPath, `agenthub-pre-${agentKey}-${taskId}`)
    }

    // 确保 base branch 存在且最新
    const baseBranch = await this.inferBaseBranch(projectPath)
    await this.fetchIfNeeded(projectPath, baseBranch)

    // 创建分支但不切换
    await this.execGit(projectPath, ['branch', branch, baseBranch])

    // 使用 git worktree 创建独立工作目录
    const worktreePath = join(tmpdir(), `agenthub-wt-${randomUUID()}`)
    await this.execGit(projectPath, ['worktree', 'add', worktreePath, branch])

    logger.info({ worktreePath, branch }, 'Git worktree created for agent task')

    return { branch, originalBranch, projectPath, worktreePath }
  }

  /**
   * 清理分支：移除 worktree、删除临时分支、切回原分支
   */
  async cleanupBranch(ctx: BranchContext, options: { keepBranch?: boolean } = {}): Promise<void> {
    const { branch, originalBranch, projectPath, worktreePath } = ctx

    try {
      // 移除 worktree（强制，即使有未跟踪文件）
      await this.execGit(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch((err) => {
        logger.warn({ err: err?.message, worktreePath }, 'Failed to remove worktree via git, trying manual cleanup')
        try { rmSync(worktreePath, { recursive: true, force: true }) } catch {}
      })

      // 切回原分支
      await this.execGit(projectPath, ['checkout', originalBranch])

      // 尝试恢复 stash
      await this.popStashIfExists(projectPath, `agenthub-pre-${branch.split('/').pop()}`)

      // 删除临时分支（除非显式保留）
      if (!options.keepBranch) {
        await this.execGit(projectPath, ['branch', '-D', branch]).catch(() => {
          logger.warn({ branch }, 'Failed to delete agent branch (may not exist)')
        })
      }
    } catch (err: any) {
      logger.error({ err: err?.message, branch, projectPath }, 'Branch cleanup error')
    }
  }

  /**
   * 收集该分支相对于 base 的所有变更
   */
  async collectDiff(projectPath: string, branch: string, baseBranch?: string): Promise<string> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    try {
      return await this.execGit(projectPath, ['diff', `${base}...${branch}`])
    } catch {
      return ''
    }
  }

  async collectChangedFiles(projectPath: string, branch: string, baseBranch?: string): Promise<string[]> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    try {
      const output = await this.execGit(projectPath, ['diff', '--name-only', `${base}...${branch}`])
      return output.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 获取文件变更状态（created/modified/deleted）
   */
  async getFileStatus(
    projectPath: string,
    filePath: string,
    branch: string,
    baseBranch?: string
  ): Promise<'created' | 'modified' | 'deleted' | 'untracked'> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    try {
      const output = await this.execGit(projectPath, ['diff', '--name-status', `${base}...${branch}`, '--', filePath])
      const status = output.trim().split('\t')[0]
      if (status === 'A') return 'created'
      if (status === 'D') return 'deleted'
      if (status === 'M') return 'modified'
      return 'untracked'
    } catch {
      return 'untracked'
    }
  }

  /**
   * 尝试将 agent 分支合并到临时分支，检测冲突
   */
  async tryMerge(projectPath: string, agentBranches: string[], baseBranch?: string): Promise<MergeResult> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    const tmpBranch = `agenthub/merge-tmp-${Date.now()}`

    try {
      // 从 base 创建临时合并分支
      await this.execGit(projectPath, ['checkout', '-b', tmpBranch, base])

      const conflictFiles: string[] = []

      for (const branch of agentBranches) {
        try {
          await this.execGit(projectPath, ['merge', '--no-commit', '--no-ff', branch])
        } catch {
          // merge 可能产生冲突，检查冲突文件
          const conflicts = await this.getConflictFiles(projectPath)
          conflictFiles.push(...conflicts)

          // 中止合并，清理状态
          await this.execGit(projectPath, ['merge', '--abort']).catch(() => {})
          await this.execGit(projectPath, ['checkout', tmpBranch]).catch(() => {})
          await this.execGit(projectPath, ['reset', '--hard']).catch(() => {})
        }
      }

      // 清理临时分支
      await this.execGit(projectPath, ['checkout', base]).catch(() => {})
      await this.execGit(projectPath, ['branch', '-D', tmpBranch]).catch(() => {})

      return {
        clean: conflictFiles.length === 0,
        conflictFiles: [...new Set(conflictFiles)],
      }
    } catch (err: any) {
      // 清理临时分支
      await this.execGit(projectPath, ['checkout', base]).catch(() => {})
      await this.execGit(projectPath, ['branch', '-D', tmpBranch]).catch(() => {})
      return { clean: false, conflictFiles: [] }
    }
  }

  /**
   * 将指定分支 squash 合并到 base
   */
  async squashMerge(projectPath: string, sourceBranch: string, targetBranch?: string, message?: string): Promise<void> {
    const target = targetBranch ?? (await this.inferBaseBranch(projectPath))
    await this.execGit(projectPath, ['checkout', target])
    await this.execGit(projectPath, ['merge', '--squash', sourceBranch])
    await this.execGit(projectPath, ['commit', '-m', message ?? `Merge changes from ${sourceBranch}`])
  }

  /**
   * 丢弃分支所有变更（hard reset 到 base）
   */
  async resetToBase(projectPath: string, branch: string, baseBranch?: string): Promise<void> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    await this.execGit(projectPath, ['checkout', branch])
    await this.execGit(projectPath, ['reset', '--hard', base])
  }

  // ===== 内部辅助 =====

  private async getCurrentBranch(projectPath: string): Promise<string> {
    return (await this.execGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  }

  async inferBaseBranch(projectPath: string): Promise<string> {
    try {
      await this.execGit(projectPath, ['rev-parse', '--verify', 'main'])
      return 'main'
    } catch {
      try {
        await this.execGit(projectPath, ['rev-parse', '--verify', 'master'])
        return 'master'
      } catch {
        return 'HEAD'
      }
    }
  }

  private async hasUncommittedChanges(projectPath: string): Promise<boolean> {
    const output = await this.execGit(projectPath, ['status', '--porcelain'])
    return output.trim().length > 0
  }

  private async stash(projectPath: string, message: string): Promise<void> {
    await this.execGit(projectPath, ['stash', 'push', '-m', message])
  }

  private async popStashIfExists(projectPath: string, messagePrefix: string): Promise<void> {
    try {
      const list = await this.execGit(projectPath, ['stash', 'list'])
      const lines = list.split('\n')
      const match = lines.find((line) => line.includes(messagePrefix))
      if (match) {
        const stashIndex = match.split(':')[0]
        if (stashIndex) {
          await this.execGit(projectPath, ['stash', 'pop', stashIndex])
        }
      }
    } catch {
      // stash 可能不存在，忽略
    }
  }

  private async fetchIfNeeded(projectPath: string, branch: string): Promise<void> {
    // 简单实现：不做 fetch，假设本地有 base branch
    // 生产环境可以加上 `git fetch origin ${branch}`
  }

  private async getConflictFiles(projectPath: string): Promise<string[]> {
    try {
      const output = await this.execGit(projectPath, ['diff', '--name-only', '--diff-filter=U'])
      return output.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  private async execGit(projectPath: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(['git', ...args], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0 && stderr) {
      throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
    }
    return stdout
  }
}

export const gitBranchManager = new GitBranchManager()
