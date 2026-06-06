import './setup'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const {
  db,
  matrixIdentities,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  sessions,
  workerInstances,
  workspaceAgents,
  workspaces,
} = dbApi
const {
  ensureManagerAgentContract,
  ensureManagerAgentContractFromController,
  ensureWorkerAgentContract,
} = await import('../apps/server/src/services/agent-contract')
const { projectWorkerContractIntoBridgeCwd } = await import('../apps/server/src/services/worker-runtime/worker-bridge-contract')

describe('Agent contract generator', () => {
  test('creates normalized Manager contract files and mirrors OpenClaw agentDir context', () => {
    const ws = ensureManagerAgentContract({
      managerId: `contract-manager-${Date.now()}`,
      runtimeType: 'openclaw',
      matrixUserId: '@manager:agenthub.local',
      participantId: 'manager-participant-1',
      controllerUrl: 'http://127.0.0.1:8000',
      sharedStorageRoot: '.agenthub/shared',
      matrixHomeserverUrl: 'http://localhost:6167',
      matrixServerName: 'agenthub.local',
      runtimeConfigPath: 'openclaw.json',
      currentRooms: [{
        roomId: 'room-1',
        roomKind: 'group',
        providerRoomId: '!room:agenthub.local',
        participantId: 'manager-participant-1',
        title: 'Manager Contract Group',
      }],
    })

    for (const path of [
      ws.runtimePath,
      ws.soulPath,
      ws.agentsPath,
      ws.toolsPath,
      ws.heartbeatPath,
      ws.workerRegistryPath,
      ws.teamRegistryPath,
      ws.humanRegistryPath,
      ws.statePath,
      ws.roomsPath,
    ]) {
      expect(existsSync(path)).toBe(true)
    }

    expect(existsSync(`${ws.skillsDir}/worker-management/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/review-and-synthesis/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/error-recovery/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/capacity-management/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/artifact-management/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/heartbeat/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.skillsDir}/memory-management/SKILL.md`)).toBe(true)
    expect(existsSync(`${ws.agentDir}/SOUL.md`)).toBe(true)
    expect(existsSync(`${ws.agentDir}/AGENTS.md`)).toBe(true)
    expect(existsSync(`${ws.agentDir}/skills/agenthub-controller/SKILL.md`)).toBe(true)

    const soulText = readFileSync(ws.soulPath, 'utf8')
    expect(soulText).toContain('Runtime Architecture')
    expect(soulText).toContain('OpenClaw Manager')
    expect(soulText).toContain('Worker Reconcile')

    const agentsText = readFileSync(ws.agentsPath, 'utf8')
    expect(agentsText).toContain('AGENTHUB:MANAGER-CONTEXT:START')
    expect(agentsText).toContain('Runtime type: openclaw')
    expect(agentsText).toContain('Matrix user id: @manager:agenthub.local')
    expect(agentsText).toContain('Controller API: http://127.0.0.1:8000')
    expect(agentsText).toContain('Manager Contract Group')
    expect(agentsText).toContain('Runtime Base Contract')

    const updated = ensureManagerAgentContract({
      managerId: ws.root.split(/[\\/]/).pop()!,
      runtimeType: 'qwenpaw',
      matrixUserId: '@manager-updated:agenthub.local',
    })
    const updatedAgentsText = readFileSync(updated.agentsPath, 'utf8')
    expect(updatedAgentsText.match(/AGENTHUB:MANAGER-CONTEXT:START/g)).toHaveLength(1)
    expect(updatedAgentsText).toContain('Runtime type: qwenpaw')
    expect(updatedAgentsText).toContain('Matrix user id: @manager-updated:agenthub.local')
    expect(updatedAgentsText).not.toContain('Matrix user id: @manager:agenthub.local')

    const runtime = JSON.parse(readFileSync(ws.runtimePath, 'utf8')) as Record<string, unknown>
    expect(runtime.runtimeFamily).toBe('manager')
    expect(runtime.runtimeType).toBe('qwenpaw')
  })

  test('refreshes Manager registries from Controller resources', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Manager Registry Workspace',
        goal: 'Verify Manager reads Controller-backed registries',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Registry Worker',
        role: 'Runtime registry specialist',
        roleType: 'coder',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        modelId: 'mimo-v2.5',
        capabilityTags: ['registry', 'runtime'],
        skillIds: ['task-management'],
      })
      .returning()
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'opencode',
        modelId: 'mimo-v2.5',
        skillIds: ['task-management'],
        observedState: 'listening',
        desiredState: 'running',
        lastHeartbeatAt: new Date(),
      })
      .returning()
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: `!manager-registry-${Date.now()}:agenthub.local`,
        kind: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Manager Registry Group',
        status: 'active',
      })
      .returning()
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Manager Registry Session',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    await db.insert(roomParticipants).values([
      {
        roomId: room!.id,
        participantType: 'manager',
        providerUserId: '@manager:agenthub.local',
        displayName: 'Manager',
        role: 'manager',
      },
      {
        roomId: room!.id,
        participantType: 'human',
        userId: 'default-user',
        providerUserId: '@human-default:agenthub.local',
        displayName: 'Human Default',
        role: 'owner',
      },
      {
        roomId: room!.id,
        participantType: 'worker',
        workspaceAgentId: agent!.id,
        workerInstanceId: worker!.id,
        providerUserId: '@registry-worker:agenthub.local',
        displayName: 'Registry Worker',
        role: 'member',
      },
    ])
    await db.insert(matrixIdentities).values({
      ownerType: 'worker',
      ownerId: worker!.id,
      serverName: 'agenthub.local',
      localpart: `worker-${worker!.id}`,
      userId: '@registry-worker:agenthub.local',
      displayName: 'Registry Worker',
      metadata: {
        matrixSync: {
          status: 'ok',
          lastSyncAt: '2026-06-07T00:00:00.000Z',
        },
      },
    })
    await db.insert(runtimeLeases).values({
      workspaceId: workspace!.id,
      workerInstanceId: worker!.id,
      provider: 'local-workdir',
      status: 'running',
      metadata: {},
    })
    await db.insert(orchestratorRuns).values({
      workspaceId: workspace!.id,
      groupSessionId: session!.id,
      status: 'running',
    })

    const ws = await ensureManagerAgentContractFromController({
      managerId: `controller-registry-${Date.now()}`,
      runtimeType: 'openclaw',
      matrixUserId: '@manager:agenthub.local',
    })

    const workersRegistry = JSON.parse(readFileSync(ws.workerRegistryPath, 'utf8')) as Record<string, any>
    expect(workersRegistry.source).toBe('agenthub-controller')
    expect(workersRegistry.workers.some((item: any) => item.workerInstanceId === worker!.id)).toBe(true)
    const registryWorker = workersRegistry.workers.find((item: any) => item.workerInstanceId === worker!.id)
    expect(registryWorker.runtimeBase).toBe('opencode')
    expect(registryWorker.runtimeContract.mode).toBe('bridge')
    expect(registryWorker.runtimeContract.baseProfile.label).toBe('OpenCode Worker')
    expect(registryWorker.runtimeContract.baseProfile.matrixIntegration.owner).toBe('agenthub-supervisor')
    expect(registryWorker.runtimeContract.diagnosticContract.readinessSource).toContain('inspectCodeAgentRuntime')
    expect(registryWorker.runtimeContract.diagnosticContract.probes).toEqual(expect.arrayContaining([
      'doctor-probe',
      'capability-probe',
    ]))
    expect(registryWorker.runtimeContract.parityCapabilities).toEqual(expect.arrayContaining([
      'matrix_identity',
      'room_timeline_io',
      'workspace_contract',
      'heartbeat',
    ]))
    expect(registryWorker.matrixUserId).toBe('@registry-worker:agenthub.local')
    expect(registryWorker.roomIds).toContain(room!.id)
    expect(registryWorker.activeLeaseIds).toHaveLength(1)

    const roomsMirror = JSON.parse(readFileSync(ws.roomsPath, 'utf8')) as Record<string, any>
    expect(roomsMirror.rooms.some((item: any) => item.roomId === room!.id && item.title === 'Manager Registry Group')).toBe(true)

    const humansRegistry = JSON.parse(readFileSync(ws.humanRegistryPath, 'utf8')) as Record<string, any>
    expect(humansRegistry.humans.some((item: any) => item.matrixUserId === '@human-default:agenthub.local')).toBe(true)

    const state = JSON.parse(readFileSync(ws.statePath, 'utf8')) as Record<string, any>
    expect(state.source).toBe('agenthub-controller')
    expect(state.resources.workers).toBeGreaterThanOrEqual(1)
    expect(state.activeRuns.some((item: any) => item.workspaceId === workspace!.id)).toBe(true)
    expect(state.heartbeat.lastMatrixSyncAt).toBe('2026-06-07T00:00:00.000Z')
  })

  test('creates normalized Worker contract files and refreshes AGENTS collaboration context', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Agent Contract Workspace',
        goal: 'Verify SOUL AGENTS state rooms tasks contract',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Contract Worker',
        role: 'Implementation specialist',
        roleType: 'builder',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        modelId: 'mimo-v2.5',
        sandboxPolicy: 'workspace-write',
        skillIds: [],
      })
      .returning()

    const ws = await ensureWorkerAgentContract({
      workerInstanceId: `contract-worker-${Date.now()}`,
      agent: agent!,
      runtimeBase: 'opencode',
      matrixUserId: '@contract-worker:agenthub.local',
      participantId: 'participant-1',
      runtimeConfigPath: 'runtime-config.json',
      controllerUrl: 'http://127.0.0.1:8000',
      sharedStorageRoot: '.agenthub/shared',
      currentRooms: [{
        roomId: 'room-1',
        roomKind: 'group',
        providerRoomId: '!room:agenthub.local',
        participantId: 'participant-1',
        title: 'Contract Group',
      }],
    })

    for (const path of [
      ws.profilePath,
      ws.runtimePath,
      ws.soulPath,
      ws.agentsPath,
      ws.statePath,
      ws.roomsPath,
      ws.tasksPath,
    ]) {
      expect(existsSync(path)).toBe(true)
    }

    const agentsText = readFileSync(ws.agentsPath, 'utf8')
    expect(agentsText).toContain('AGENTHUB:COLLABORATION-CONTEXT:START')
    expect(agentsText).toContain('Runtime base: opencode')
    expect(agentsText).toContain('Runtime mode: bridge')
    expect(agentsText).toContain('Worker Reconcile Contract')
    expect(agentsText).toContain('Diagnostic readiness source: inspectCodeAgentRuntime')
    expect(agentsText).toContain('Blocking diagnostic signals: contract_missing')
    expect(agentsText).toContain('Diagnostic probes: command-installed, native-version-probe, doctor-probe, capability-probe')
    expect(agentsText).toContain('Expected native capabilities: auth, models, mcp')
    expect(agentsText).toContain('Matrix user id: @contract-worker:agenthub.local')
    expect(agentsText).toContain('Controller API: http://127.0.0.1:8000')
    expect(agentsText).toContain('Contract Group')

    const soulText = readFileSync(ws.soulPath, 'utf8')
    expect(soulText).toContain('Runtime Adapter Identity')
    expect(soulText).toContain('OpenCode Worker base')

    const updated = await ensureWorkerAgentContract({
      workerInstanceId: ws.root.split(/[\\/]/).pop()!,
      agent: agent!,
      runtimeBase: 'opencode',
      matrixUserId: '@contract-worker-updated:agenthub.local',
    })
    const updatedAgentsText = readFileSync(updated.agentsPath, 'utf8')
    expect(updatedAgentsText.match(/AGENTHUB:COLLABORATION-CONTEXT:START/g)).toHaveLength(1)
    expect(updatedAgentsText).toContain('Matrix user id: @contract-worker-updated:agenthub.local')
    expect(updatedAgentsText).not.toContain('Matrix user id: @contract-worker:agenthub.local')

    const runtime = JSON.parse(readFileSync(ws.runtimePath, 'utf8')) as Record<string, unknown>
    expect(runtime.runtimeBase).toBe('opencode')
    expect(runtime.runtimeMode).toBe('bridge')
    expect(runtime.modelId).toBe('mimo-v2.5')
    const adapterContract = runtime.adapterContract as Record<string, unknown>
    expect(adapterContract.parityCapabilities).toEqual(expect.arrayContaining([
      'matrix_identity',
      'room_timeline_io',
      'SOUL.md',
      'AGENTS.md',
      'heartbeat',
      'clarification_resume',
    ]))
    const baseProfile = adapterContract.baseProfile as {
      label: string
      implementation: { architectureMode: string; processModel: string; healthSource: string }
      matrixIntegration: { owner: string; pattern: string }
    }
    expect(baseProfile.label).toBe('OpenCode Worker')
    expect(baseProfile.implementation.architectureMode).toBe('bridge')
    expect(baseProfile.matrixIntegration.owner).toBe('agenthub-supervisor')
  })

  test('Worker runtime adapter contract records base-specific parity profiles', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Runtime Adapter Contract Workspace',
        goal: 'Verify per-base runtime contract parity',
      })
      .returning()

    const expected = [
      { base: 'openclaw', mode: 'resident', label: 'OpenClaw Worker', architectureMode: 'gateway', listenerOwner: 'runtime-native', managerEligible: true },
      { base: 'qwenpaw', mode: 'resident', label: 'QwenPaw Worker', architectureMode: 'workspace', listenerOwner: 'runtime-native', managerEligible: true },
      { base: 'claude-code', mode: 'bridge', label: 'Claude Code Worker', architectureMode: 'bridge', listenerOwner: 'agenthub-supervisor', managerEligible: false },
      { base: 'opencode', mode: 'bridge', label: 'OpenCode Worker', architectureMode: 'bridge', listenerOwner: 'agenthub-supervisor', managerEligible: false },
      { base: 'codex', mode: 'bridge', label: 'Codex Worker', architectureMode: 'bridge', listenerOwner: 'agenthub-supervisor', managerEligible: false },
      { base: 'gemini', mode: 'bridge', label: 'Gemini CLI Worker', architectureMode: 'bridge', listenerOwner: 'agenthub-supervisor', managerEligible: false },
    ]

    for (const item of expected) {
      const [agent] = await db
        .insert(workspaceAgents)
        .values({
          workspaceId: workspace!.id,
          name: `${item.label} Contract`,
          role: 'Runtime parity worker',
          roleType: 'builder',
          runtimeType: 'code-agent',
          codeAgentType: item.mode === 'bridge' ? item.base : null,
          modelId: 'test-model',
          roleProfile: { workerRuntimeBase: item.base },
          skillIds: [],
        })
        .returning()
      const ws = await ensureWorkerAgentContract({
        workerInstanceId: `runtime-contract-${item.base}-${Date.now()}`,
        agent: agent!,
        runtimeBase: item.base,
      })
      const runtime = JSON.parse(readFileSync(ws.runtimePath, 'utf8')) as {
        runtimeBase: string
        runtimeMode: string
        adapterContract: {
          mode: string
          parityCapabilities: string[]
          diagnosticContract: {
            readinessSource: string
            probes: string[]
            expectedNativeCapabilities: string[]
          }
          baseProfile: {
            label: string
            roleEligibility: { manager: boolean; worker: boolean }
            implementation: { architectureMode: string }
            matrixIntegration: { owner: string }
            currentLimits: string[]
          }
        }
      }

      expect(runtime.runtimeBase).toBe(item.base)
      expect(runtime.runtimeMode).toBe(item.mode)
      expect(runtime.adapterContract.mode).toBe(item.mode)
      expect(runtime.adapterContract.diagnosticContract.probes.length).toBeGreaterThan(0)
      expect(runtime.adapterContract.parityCapabilities).toEqual(expect.arrayContaining([
        'matrix_identity',
        'room_timeline_io',
        'mention_dispatch',
        'workspace_contract',
        'shared_task_contract',
        'heartbeat',
        'transparent_blockers',
      ]))
      expect(runtime.adapterContract.baseProfile.label).toBe(item.label)
      expect(runtime.adapterContract.baseProfile.roleEligibility.manager).toBe(item.managerEligible)
      expect(runtime.adapterContract.baseProfile.roleEligibility.worker).toBe(true)
      expect(runtime.adapterContract.baseProfile.implementation.architectureMode).toBe(item.architectureMode)
      expect(runtime.adapterContract.baseProfile.matrixIntegration.owner).toBe(item.listenerOwner)
      if (item.base === 'qwenpaw') {
        expect(runtime.adapterContract.baseProfile.currentLimits.join(' ')).toContain('WorkerBackend is not implemented')
        expect(runtime.adapterContract.diagnosticContract.expectedNativeCapabilities).toContain('runtime-native-matrix-listener')
      }
      if (item.mode === 'bridge') {
        expect(runtime.adapterContract.baseProfile.currentLimits.join(' ')).toContain('not yet a runtime-native Matrix listener')
        expect(runtime.adapterContract.diagnosticContract.readinessSource).toContain('inspectCodeAgentRuntime')
        expect(runtime.adapterContract.diagnosticContract.probes).toContain('capability-probe')
      }
    }
  })

  test('projects Worker contract into bridge CLI execution cwd idempotently', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Bridge Contract Workspace',
        goal: 'Verify bridge CLI sees SOUL AGENTS skills contract',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Bridge Contract Worker',
        role: 'Bridge implementation specialist',
        roleType: 'coder',
        description: 'Runs through AgentHub-managed CLI bridge but follows the same Worker contract.',
        systemPrompt: 'Follow Matrix room protocol and write back clear progress.',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        modelId: 'mimo-v2.5',
        sandboxPolicy: 'workspace-write',
        skillIds: [],
      })
      .returning()
    const executionCwd = mkdtempSync(join(tmpdir(), 'agenthub-bridge-contract-'))

    const projection = await projectWorkerContractIntoBridgeCwd({
      workerInstanceId: `bridge-contract-worker-${Date.now()}`,
      agent: agent!,
      executionCwd,
      runtimeBase: 'opencode',
      room: {
        roomId: 'room-bridge',
        roomKind: 'task',
        providerRoomId: '!bridge:agenthub.local',
        participantId: 'participant-bridge',
        title: 'Bridge Task Room',
      },
      controllerUrl: 'http://127.0.0.1:8000',
      sharedStorageRoot: '.agenthub/shared',
    })

    expect(projection).toBeTruthy()
    expect(existsSync(join(executionCwd, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(executionCwd, '.agenthub', 'worker-contract', 'SOUL.md'))).toBe(true)
    expect(existsSync(join(executionCwd, '.agenthub', 'worker-contract', 'profile.json'))).toBe(true)

    const agentsText = readFileSync(join(executionCwd, 'AGENTS.md'), 'utf8')
    expect(agentsText).toContain('AGENTHUB:BRIDGE-RUNTIME-CONTEXT:START')
    expect(agentsText).toContain('Canonical Worker AGENTS.md')
    expect(agentsText).toContain('Runtime base: opencode')
    expect(agentsText).toContain('Bridge Task Room')

    await projectWorkerContractIntoBridgeCwd({
      workerInstanceId: projection!.contract.root.split(/[\\/]/).pop()!,
      agent: agent!,
      executionCwd,
      runtimeBase: 'opencode',
    })
    const updatedAgentsText = readFileSync(join(executionCwd, 'AGENTS.md'), 'utf8')
    expect(updatedAgentsText.match(/AGENTHUB:BRIDGE-RUNTIME-CONTEXT:START/g)).toHaveLength(1)
  })
})
