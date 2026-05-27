import { logger } from '../../lib/logger'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface BranchContext {
  branch: string
  originalBranch: string
  projectPath: string
  worktreePath: string
  stashRef?: string
}

export interface MergeResult {
  clean: boolean
  conflictFiles: string[]
  mergedBranch?: string
}

/**
 * 项目级互斥锁：同一个 projectPath 的 git 操作串行执行
 * 防止并发 stash/checkout/branch 产生竞态条件
 */
class ProjectLock {
  private locks = new Map<string, Promise<void>>()

  async acquire(projectPath: string): Promise<() => void> {
    while (this.locks.has(projectPath)) {
      await this.locks.get(projectPath)
    }
    let release: () => void
    const lock = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(projectPath, lock)
    return () => {
      this.locks.delete(projectPath)
      release!()
    }
  }
}

const projectLock = new ProjectLock()

export class GitBranchManager {
  async ensureGitRepo(projectPath: string): Promise<void> {
    const gitDir = join(projectPath, '.git')
    if (existsSync(gitDir)) {
      try {
        await this.execGit(projectPath, ['rev-parse', 'HEAD'])
        return
      } catch {
        // .git 存在但没有 commit，继续初始化
      }
    }

    logger.info({ projectPath }, 'Auto-initializing git repo for workspace')
    await this.execGit(projectPath, ['init'])
    await this.execGit(projectPath, ['config', 'user.email', 'agenthub@local'])
    await this.execGit(projectPath, ['config', 'user.name', 'AgentHub'])
    await this.execGit(projectPath, ['commit', '--allow-empty', '-m', 'init: AgentHub workspace'])
  }

  async prepareBranch(
    projectPath: string,
    runId: string,
    agentKey: string,
    taskId: string
  ): Promise<BranchContext> {
    const release = await projectLock.acquire(projectPath)
    try {
      return await this._prepareBranchUnsafe(projectPath, runId, agentKey, taskId)
    } finally {
      release()
    }
  }

  private async _prepareBranchUnsafe(
    projectPath: string,
    runId: string,
    agentKey: string,
    taskId: string
  ): Promise<BranchContext> {
    await this.ensureGitRepo(projectPath)

    const branch = `agenthub/${runId}/${agentKey}/${taskId}`
    const originalBranch = await this.getCurrentBranch(projectPath)
    logger.info({ projectPath, originalBranch, newBranch: branch }, 'Preparing agent branch')

    // stash 当前未提交变更，记录 stash ref 以便精确恢复
    let stashRef: string | undefined
    const hasChanges = await this.hasUncommittedChanges(projectPath)
    if (hasChanges) {
      const stashMessage = `agenthub-stash-${runId}-${agentKey}-${taskId}`
      await this.execGit(projectPath, ['stash', 'push', '-m', stashMessage])
      const stashList = await this.execGit(projectPath, ['stash', 'list'])
      const stashLine = stashList.split('\n').find((line) => line.includes(stashMessage))
      if (stashLine) {
        stashRef = stashLine.split(':')[0]
      }
    }

    const baseBranch = await this.inferBaseBranch(projectPath)

    // 创建分支但不切换
    await this.execGit(projectPath, ['branch', branch, baseBranch])

    // git worktree 创建独立工作目录
    const worktreePath = join(tmpdir(), `agenthub-wt-${randomUUID()}`)
    await this.execGit(projectPath, ['worktree', 'add', worktreePath, branch])

    logger.info({ worktreePath, branch }, 'Git worktree created for agent task')

    return { branch, originalBranch, projectPath, worktreePath, stashRef }
  }

  async cleanupBranch(ctx: BranchContext, options: { keepBranch?: boolean } = {}): Promise<void> {
    const release = await projectLock.acquire(ctx.projectPath)
    try {
      await this._cleanupBranchUnsafe(ctx, options)
    } finally {
      release()
    }
  }

  private async _cleanupBranchUnsafe(ctx: BranchContext, options: { keepBranch?: boolean } = {}): Promise<void> {
    const { branch, originalBranch, projectPath, worktreePath, stashRef } = ctx

    try {
      // 移除 worktree
      await this.execGit(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch((err) => {
        logger.warn({ err: err?.message, worktreePath }, 'Failed to remove worktree via git, trying manual cleanup')
        try { rmSync(worktreePath, { recursive: true, force: true }) } catch {}
      })

      // 切回原分支
      await this.execGit(projectPath, ['checkout', originalBranch]).catch(() => {})

      // 精确恢复 stash（用 ref 而非字符串匹配）
      if (stashRef) {
        try {
          await this.execGit(projectPath, ['stash', 'pop', stashRef])
        } catch (err: any) {
          logger.warn({ err: err?.message, stashRef }, 'Failed to pop stash (may have conflicts)')
        }
      }

      // 删除临时分支
      if (!options.keepBranch) {
        await this.execGit(projectPath, ['branch', '-D', branch]).catch(() => {
          logger.warn({ branch }, 'Failed to delete agent branch (may not exist)')
        })
      }
    } catch (err: any) {
      logger.error({ err: err?.message, branch, projectPath }, 'Branch cleanup error')
    }
  }

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

  async tryMerge(projectPath: string, agentBranches: string[], baseBranch?: string): Promise<MergeResult> {
    const release = await projectLock.acquire(projectPath)
    try {
      return await this._tryMergeUnsafe(projectPath, agentBranches, baseBranch)
    } finally {
      release()
    }
  }

  private async _tryMergeUnsafe(projectPath: string, agentBranches: string[], baseBranch?: string): Promise<MergeResult> {
    const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
    const tmpBranch = `agenthub/merge-tmp-${Date.now()}`

    try {
      await this.execGit(projectPath, ['checkout', '-b', tmpBranch, base])

      const conflictFiles: string[] = []

      for (const branch of agentBranches) {
        try {
          await this.execGit(projectPath, ['merge', '--no-commit', '--no-ff', branch])
        } catch {
          const conflicts = await this.getConflictFiles(projectPath)
          conflictFiles.push(...conflicts)
          await this.execGit(projectPath, ['merge', '--abort']).catch(() => {})
          await this.execGit(projectPath, ['checkout', tmpBranch]).catch(() => {})
          await this.execGit(projectPath, ['reset', '--hard']).catch(() => {})
        }
      }

      await this.execGit(projectPath, ['checkout', base]).catch(() => {})
      await this.execGit(projectPath, ['branch', '-D', tmpBranch]).catch(() => {})

      return {
        clean: conflictFiles.length === 0,
        conflictFiles: [...new Set(conflictFiles)],
      }
    } catch (err: any) {
      await this.execGit(projectPath, ['checkout', base]).catch(() => {})
      await this.execGit(projectPath, ['branch', '-D', tmpBranch]).catch(() => {})
      return { clean: false, conflictFiles: [] }
    }
  }

  async squashMerge(projectPath: string, sourceBranch: string, targetBranch?: string, message?: string): Promise<void> {
    const release = await projectLock.acquire(projectPath)
    try {
      const target = targetBranch ?? (await this.inferBaseBranch(projectPath))
      await this.execGit(projectPath, ['checkout', target])
      await this.execGit(projectPath, ['merge', '--squash', sourceBranch])
      await this.execGit(projectPath, ['commit', '-m', message ?? `Merge changes from ${sourceBranch}`])
    } finally {
      release()
    }
  }

  async resetToBase(projectPath: string, branch: string, baseBranch?: string): Promise<void> {
    const release = await projectLock.acquire(projectPath)
    try {
      const base = baseBranch ?? (await this.inferBaseBranch(projectPath))
      await this.execGit(projectPath, ['checkout', branch])
      await this.execGit(projectPath, ['reset', '--hard', base])
    } finally {
      release()
    }
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
