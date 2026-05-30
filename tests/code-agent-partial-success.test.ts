import { describe, expect, test } from 'bun:test'

describe('code agent partial success handling', () => {
  test('treats webfetch 404 as a fetch problem instead of a model problem', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const message = __codeAgentAdapterTestHooks.friendlyCodeAgentError(
      'webfetch failed: Request failed with status code 404',
      'OpenCode',
    )

    expect(message).toContain('网页抓取失败')
    expect(message).not.toContain('模型或 Base URL')
  })

  test('allows non-strict tasks to accept partial results when files were produced', async () => {
    const { __taskExecutionTestHooks } = await import(
      '../apps/server/src/services/execution/task-execution-service'
    )

    expect(
      __taskExecutionTestHooks.shouldAcceptPartialExecution('research', [{ path: 'report.md' }]),
    ).toBe(true)
    expect(
      __taskExecutionTestHooks.shouldAcceptPartialExecution('design', [{ path: 'mock.html' }]),
    ).toBe(true)
    expect(
      __taskExecutionTestHooks.shouldAcceptPartialExecution('code', [{ path: 'index.ts' }]),
    ).toBe(false)
    expect(__taskExecutionTestHooks.shouldAcceptPartialExecution('research', [])).toBe(false)
  })

  test('treats explicit execution failure text as a real failure', async () => {
    const { __agentRunnerTestHooks } = await import('../apps/server/src/services/agent-runner')

    expect(__agentRunnerTestHooks.looksLikeAgentFailure('**OpenCode 执行失败**')).toBe(true)
    expect(__agentRunnerTestHooks.looksLikeAgentFailure('**OpenCode 已结束，但带有警告**')).toBe(
      false,
    )
  })
})
