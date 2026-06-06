import './setup'
import { describe, expect, test } from 'bun:test'
import { memberProposalsFromManagerAction } from '../apps/server/src/services/manager-runtime/member-proposals'

describe('Manager member proposals', () => {
  test('does not silently default missing Worker runtime base to Codex', () => {
    const proposals = memberProposalsFromManagerAction({
      type: 'create_worker',
      message: 'Need an architect',
      metadata: {
        name: '架构师',
        role: '系统架构设计',
        reason: '需要补齐架构设计能力',
        modelId: 'mimo-v2.5',
      },
    })

    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.codeAgentType).toBeNull()
    expect(proposals[0]?.workerRuntimeBase).toBeNull()
  })

  test('keeps explicit Worker runtime base from Manager output', () => {
    const proposals = memberProposalsFromManagerAction({
      type: 'create_worker',
      message: 'Need a product manager',
      metadata: {
        name: '产品经理',
        role: '需求澄清',
        reason: '需要产品判断',
        workerRuntimeBase: 'opencode',
        codeAgentType: 'opencode',
        modelId: 'mimo-v2.5',
      },
    })

    expect(proposals[0]?.codeAgentType).toBe('opencode')
    expect(proposals[0]?.workerRuntimeBase).toBe('opencode')
  })
})
