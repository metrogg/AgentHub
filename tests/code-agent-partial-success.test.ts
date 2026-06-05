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

  test('builds OpenClaw args from the local OpenClaw agent identity without model injection', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const args = __codeAgentAdapterTestHooks.buildOpenClawArgs('Read prompt', {
      roleProfile: { source: 'openclaw', openclawAgentId: 'main' },
      modelId: 'should-not-pass',
      modelProvider: 'should-not-pass',
    })

    expect(args).toEqual([
      'agent',
      '--agent',
      'main',
      '--message',
      'Read prompt',
      '--json',
      '--local',
    ])
    expect(args).not.toContain('--model')
    expect(args).not.toContain('should-not-pass')
  })

  test('asks OpenClaw to read the generated prompt file when the task prompt is file-backed', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const args = __codeAgentAdapterTestHooks.buildOpenClawArgs('short wrapper', {
      roleProfile: { openclawAgentId: 'ops' },
      promptFile: 'C:\\Temp\\AgentHub\\task-prompt.md',
    })

    expect(args[2]).toBe('ops')
    expect(args[3]).toBe('--message')
    expect(args[4]).toContain('Prompt file path: C:\\Temp\\AgentHub\\task-prompt.md')
    expect(args[4]).not.toContain('Read the attached prompt file')
  })

  test('extracts OpenClaw JSON result messages', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    expect(
      __codeAgentAdapterTestHooks.extractOpenClawResultMessage(
        JSON.stringify({ result: { message: 'ok' } }),
      ),
    ).toBe('ok')
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

  test('injects the shared task directory contract into Code Agent prompts', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )

    const prompt = __codeAgentAdapterTestHooks.buildCodeAgentPrompt(
      {
        id: 'agent-1',
        name: 'Builder',
        role: 'Frontend Builder',
        description: 'Build deliverables',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        capabilityTags: [],
        toolPermissions: ['workspace-write'],
        sandboxPolicy: 'workspace-write',
        contextPolicy: 'workspace-aware',
        approvalRequired: false,
        projectPath: 'C:/project',
      },
      {
        id: 'msg-1',
        sessionId: 'session-1',
        senderId: 'user',
        senderType: 'user',
        type: 'text',
        content: 'Build the report page.',
        metadata: null,
        createdAt: new Date(),
      },
      [],
      'C:/project/.agenthub/workdirs/run-1/Builder/task-1',
      '',
      {
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        agentName: 'Builder',
        projectPath: 'C:/project',
        worktreePath: 'C:/project/.agenthub/workdirs/run-1/Builder/task-1',
        sandboxPolicy: 'workspace-write',
        envAllowlist: [],
        a2a: {
          protocolVersion: '0.3.0',
          method: 'message/send',
          contextId: 'group-1',
          taskId: 'task-1',
          runId: 'run-1',
          workspaceId: 'ws-1',
          groupSessionId: 'group-1',
          childSessionId: 'child-1',
          taskThreadId: 'thread-1',
          sharedTaskRelativeRoot: '.agenthub/shared/tasks/task-1',
          sharedTaskSpecPath: '.agenthub/shared/tasks/task-1/spec.md',
          fromAgentId: 'orch-1',
          fromAgentName: 'Orchestrator',
          toAgentId: 'agent-1',
          toAgentName: 'Builder',
          referenceTaskIds: [],
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-1',
              role: 'user',
              parts: [{ kind: 'text', text: 'Build the report page.' }],
            },
          },
        },
      },
    )

    expect(prompt).toContain('AgentHub 共享任务目录协议')
    expect(prompt).toContain('.agenthub/shared/tasks/task-1/spec.md')
    expect(prompt).toContain('.agenthub/shared/tasks/task-1/plan.md')
    expect(prompt).toContain('.agenthub/shared/tasks/task-1/result.md')
    expect(prompt).toContain('.agenthub/shared/tasks/task-1/artifacts/')
  })
})
