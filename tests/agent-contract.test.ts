import './setup'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const { db, workspaceAgents, workspaces } = dbApi
const { ensureManagerAgentContract, ensureWorkerAgentContract } = await import('../apps/server/src/services/agent-contract')

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
    expect(existsSync(`${ws.agentDir}/SOUL.md`)).toBe(true)
    expect(existsSync(`${ws.agentDir}/AGENTS.md`)).toBe(true)
    expect(existsSync(`${ws.agentDir}/skills/agenthub-controller/SKILL.md`)).toBe(true)

    const agentsText = readFileSync(ws.agentsPath, 'utf8')
    expect(agentsText).toContain('AGENTHUB:MANAGER-CONTEXT:START')
    expect(agentsText).toContain('Runtime type: openclaw')
    expect(agentsText).toContain('Matrix user id: @manager:agenthub.local')
    expect(agentsText).toContain('Controller API: http://127.0.0.1:8000')
    expect(agentsText).toContain('Manager Contract Group')

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
    expect(agentsText).toContain('Matrix user id: @contract-worker:agenthub.local')
    expect(agentsText).toContain('Controller API: http://127.0.0.1:8000')
    expect(agentsText).toContain('Contract Group')

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
    expect(runtime.modelId).toBe('mimo-v2.5')
  })
})
