import { describe, expect, test } from 'bun:test'
import { ROLE_PRESETS } from '../packages/shared/src/agent-role-presets'
import { PolicyGuard } from '../apps/server/src/services/policy-guard'

describe('code agent automation policy', () => {
  test('code-oriented preset agents default to automatic execution', () => {
    expect(ROLE_PRESETS.coder.approvalRequired).toBe(false)
    expect(ROLE_PRESETS.reviewer.approvalRequired).toBe(false)
    expect(ROLE_PRESETS.orchestrator.approvalRequired).toBe(false)
  })

  test('orchestrated code and verification tasks do not require manual approval', () => {
    expect(PolicyGuard.evaluate({ taskType: 'code' }).approvalRequired).toBe(false)
    expect(PolicyGuard.evaluate({ taskType: 'test' }).approvalRequired).toBe(false)
    expect(PolicyGuard.evaluate({ taskType: 'verify' }).approvalRequired).toBe(false)
  })
})
