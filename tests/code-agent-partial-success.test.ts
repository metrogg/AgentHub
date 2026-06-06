import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  test('probes bridge CLI runtime with native version and doctor commands', async () => {
    const { __codeAgentAdapterTestHooks } = await import(
      '../apps/server/src/services/code-agent-adapter'
    )
    const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-opencode-probe-'))
    const commandPath = process.platform === 'win32'
      ? join(tempDir, 'fake-opencode.cmd')
      : join(tempDir, 'fake-opencode')
    const script = process.platform === 'win32'
      ? [
          '@echo off',
          'if "%1"=="--version" echo opencode 1.2.3 & exit /b 0',
          'if "%1"=="doctor" echo doctor ok & exit /b 0',
          'echo unknown command %1',
          'exit /b 1',
        ].join('\r\n')
      : [
          '#!/usr/bin/env sh',
          'if [ "$1" = "--version" ]; then echo "opencode 1.2.3"; exit 0; fi',
          'if [ "$1" = "doctor" ]; then echo "doctor ok"; exit 0; fi',
          'echo "unknown command $1"',
          'exit 1',
        ].join('\n')
    writeFileSync(commandPath, script, 'utf8')
    if (process.platform !== 'win32') chmodSync(commandPath, 0o755)

    const nativeProbe = await __codeAgentAdapterTestHooks.probeCodeAgentNativeCli(commandPath)
    const doctorProbe = await __codeAgentAdapterTestHooks.probeCodeAgentDoctorCli('opencode', commandPath)

    expect(nativeProbe.ok).toBe(true)
    expect(nativeProbe.version).toBe('1.2.3')
    expect(doctorProbe).toMatchObject({
      kind: 'doctor',
      supported: true,
      ok: true,
    })
    expect(doctorProbe.output).toContain('doctor ok')
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
