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

  test('treats provider/model OpenCode ids as native OpenCode model references', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    expect(
      __codeAgentAdapterTestHooks.isOpenCodeNativeModelRef('xiaomi-token-plan-cn/mimo-v2.5'),
    ).toBe(true)
    expect(
      __codeAgentAdapterTestHooks.isOpenCodeNativeModelRef('opencode/deepseek-v4-flash-free'),
    ).toBe(true)
    expect(__codeAgentAdapterTestHooks.isOpenCodeNativeModelRef('mimo-v2.5')).toBe(false)

    const target = __codeAgentAdapterTestHooks.createNativeOpenCodeModelTarget(
      'xiaomi-token-plan-cn/mimo-v2.5',
    )
    expect(__codeAgentAdapterTestHooks.formatModelTargetLabel(target)).toBe(
      'xiaomi-token-plan-cn/mimo-v2.5',
    )
  })

  test('prefixes catalog OpenCode model ids with the configured provider', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const args = __codeAgentAdapterTestHooks.buildOpencodeArgs('prompt', {
      modelProvider: 'deepseek',
      modelId: 'xiaomi-token-plan-cn/mimo-v2.5',
    })

    expect(args).toContain('--model')
    expect(args).toContain('deepseek/xiaomi-token-plan-cn/mimo-v2.5')
  })

  test('explains OpenCode provider/model lookup failures precisely', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const message = __codeAgentAdapterTestHooks.friendlyCodeAgentError(
      'ProviderModelNotFoundError: ProviderModelNotFoundError\ndata: {\nproviderID: "xiaomi-token-plan-cn",\nmodelID: "mimo-v2.5"\n}',
      'OpenCode',
    )

    expect(message).toContain('provider=xiaomi-token-plan-cn')
    expect(message).toContain('model=mimo-v2.5')
    expect(message).not.toContain('Base URL 不可用')
  })
})
