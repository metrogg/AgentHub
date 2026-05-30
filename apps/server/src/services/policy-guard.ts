import { ROLE_PRESETS, type AgentRoleType } from '@agenthub/shared'
import { logger } from '../lib/logger'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface PolicyDecision {
  allowed: boolean
  riskLevel: RiskLevel
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalRequired: boolean
  toolPermissions: string[]
  reason: string
}

export interface PolicyCheckInput {
  roleType?: AgentRoleType | null
  taskType?: 'read' | 'research' | 'design' | 'code' | 'test' | 'verify' | 'review' | 'synthesize' | null
  proposedAction?: string
  targetPaths?: string[]
}

/**
 * PolicyGuard: 独立的策略/沙箱权限判断层
 * 不依赖 agent 自觉，由系统统一控制权限边界
 */
export class PolicyGuard {
  /**
   * 判断给定操作是否需要审批以及使用何种沙箱策略
   */
  static evaluate(input: PolicyCheckInput): PolicyDecision {
    const { roleType, taskType, proposedAction, targetPaths } = input

    // 默认保守策略
    let decision: PolicyDecision = {
      allowed: true,
      riskLevel: 'low',
      sandboxPolicy: 'read-only',
      approvalRequired: false,
      toolPermissions: ['chat'],
      reason: '默认自动执行策略',
    }

    // 从角色预设加载基础策略
    if (roleType && roleType !== 'custom' && roleType in ROLE_PRESETS) {
      const preset = ROLE_PRESETS[roleType]
      decision.sandboxPolicy = preset.sandboxPolicy
      decision.toolPermissions = [...preset.toolPermissions]
      decision.approvalRequired = preset.approvalRequired
      decision.reason = `角色预设策略: ${roleType}`
    }

    // 任务类型覆盖
    if (taskType === 'code') {
      decision.sandboxPolicy = 'workspace-write'
      decision.toolPermissions = ['chat', 'workspace:read', 'workspace:write']
      decision.approvalRequired = false
      decision.riskLevel = 'medium'
      decision.reason = '代码任务需要写权限'
    } else if (taskType === 'test' || taskType === 'verify') {
      decision.sandboxPolicy = 'read-only'
      decision.toolPermissions = ['chat', 'workspace:read']
      decision.approvalRequired = false
      decision.riskLevel = 'low'
      decision.reason = '验证任务只读'
    } else if (taskType === 'review') {
      decision.sandboxPolicy = 'read-only'
      decision.approvalRequired = false
      decision.riskLevel = 'low'
      decision.reason = '审查任务只读'
    }

    // 危险操作检测
    if (proposedAction) {
      const action = proposedAction.toLowerCase()
      const dangerousPatterns = [
        { pattern: /rm\s+-rf/i, risk: 'high' as RiskLevel, reason: '检测到递归删除命令' },
        { pattern: />\s*\.env/i, risk: 'high' as RiskLevel, reason: '检测到覆盖 .env 文件' },
        { pattern: /git\s+push\s+.*--force/i, risk: 'high' as RiskLevel, reason: '检测到强制推送' },
        { pattern: /curl\s+.*\|\s*sh/i, risk: 'high' as RiskLevel, reason: '检测到远程脚本执行' },
        { pattern: /eval\s*\(/i, risk: 'high' as RiskLevel, reason: '检测到 eval 执行' },
        { pattern: /chmod\s+777/i, risk: 'medium' as RiskLevel, reason: '检测到全局可执行权限' },
      ]

      for (const check of dangerousPatterns) {
        if (check.pattern.test(action)) {
          decision.riskLevel = check.risk
          decision.approvalRequired = true
          decision.reason = check.reason
          if (check.risk === 'high') {
            decision.allowed = false
          }
          break
        }
      }
    }

    // 敏感路径检测
    if (targetPaths) {
      const sensitivePaths = ['.env', '.ssh', 'id_rsa', 'credentials', 'secret', 'token', 'password']
      for (const path of targetPaths) {
        const lower = path.toLowerCase()
        if (sensitivePaths.some((s) => lower.includes(s))) {
          decision.riskLevel = 'high'
          decision.approvalRequired = true
          decision.reason = `触及敏感路径: ${path}`
          if (decision.sandboxPolicy !== 'read-only') {
            decision.allowed = false
          }
          break
        }
      }
    }

    // danger-full-access 仍保持高风险标记，但执行层默认走 CLI 自身的 full-auto / bypass 模式。
    if (decision.sandboxPolicy === 'danger-full-access') {
      decision.riskLevel = 'high'
    }

    logger.info(
      { roleType, taskType, riskLevel: decision.riskLevel, sandboxPolicy: decision.sandboxPolicy },
      'PolicyGuard evaluated',
    )

    return decision
  }

  /**
   * 判断 agent 是否具备执行某类任务的权限
   */
  static canExecuteTask(roleType: AgentRoleType | null | undefined, taskType: string): boolean {
    if (!roleType || roleType === 'custom') return true
    if (!(roleType in ROLE_PRESETS)) return false
    const preset = ROLE_PRESETS[roleType]
    return preset.roleProfile.acceptsTaskTypes.includes(taskType)
  }

  /**
   * 判断是否需要 Git 分支隔离
   */
  static needsBranchIsolation(sandboxPolicy: string): boolean {
    return sandboxPolicy !== 'read-only'
  }
}
