import { and, db, eq, roomParticipants, rooms, sessions, workerInstances, workspaceAgents, workspaces } from '@agenthub/db'
import { workerContainersEnabled } from '../container-runtime/agent-runtime-containers'
import { openclawLauncher } from '../manager-runtime/openclaw-launcher'
import { workerController } from '../orchestrator/worker-controller'
import { ensureManagerParticipantForRoom } from '../rooms/manager-participant'
import { roomService } from '../rooms/room-service'
import { ensureGroupSession } from '../workspace/session-manager'
import { ensureWorkerAgentContract } from '../agent-contract'
import type { WorkerBackend } from './worker-backend'
import {
  codeAgentTypeForRuntime,
  normalizeWorkerRuntimeBase,
  readWorkerRuntimeBase,
  workerRoleProfileFromRuntime,
  type WorkerRuntimeBase,
} from './worker-runtime-base'
import { condition, type ControllerResource } from './resource-types'

export type MemberReconcileStageName =
  | 'ResolveMemberSpec'
  | 'ApplyWorkspaceAgent'
  | 'ApplyWorkerInstance'
  | 'JoinRooms'
  | 'AnnounceAndObserve'

export interface MemberReconcileStage {
  name: MemberReconcileStageName
  ok: boolean
  message: string
  details?: Record<string, unknown>
}

export interface MemberReconcileInput {
  workspaceId: string
  name: string
  runtimeType?: string
  runtimeBase?: string
  workerRuntimeBase?: string
  codeAgentType?: string
  modelId?: string | null
  skillIds?: string[]
  role?: string
  roleType?: string
  description?: string
  systemPrompt?: string
  roleProfile?: Record<string, unknown> | null
  color?: string
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: string
  contextPolicy?: string
  autoInvoke?: boolean
  approvalRequired?: boolean
  ownerId?: string | null
  groupSessionId?: string | null
  joinGroupRoom?: boolean
  createDirectSession?: boolean
  announce?: boolean
}

export interface MemberReconcileResult {
  agentId: string
  worker: ControllerResource<'Worker'> | null
  workerInstanceId: string
  runtimeBase: WorkerRuntimeBase
  stages: MemberReconcileStage[]
  groupRoom: typeof rooms.$inferSelect | null
  directSession: typeof sessions.$inferSelect | null
  directRoom: typeof rooms.$inferSelect | null
  participants: Array<typeof roomParticipants.$inferSelect>
  announcements: Array<{ roomId: string; eventId: string }>
}

export class MemberReconciler {
  constructor(private readonly workerBackend: WorkerBackend) {}

  async reconcile(input: MemberReconcileInput): Promise<MemberReconcileResult> {
    const stages: MemberReconcileStage[] = []
    const spec = await this.resolveMemberSpec(input)
    stages.push({
      name: 'ResolveMemberSpec',
      ok: true,
      message: `Resolved Worker runtime base ${spec.runtimeBase}.`,
      details: {
        runtimeBase: spec.runtimeBase,
        modelId: spec.modelId,
        reusedExistingAgent: Boolean(spec.existingAgent),
      },
    })

    const agent = await this.applyWorkspaceAgent(input, spec)
    stages.push({
      name: 'ApplyWorkspaceAgent',
      ok: true,
      message: spec.existingAgent ? 'Updated existing workspace agent.' : 'Created workspace agent.',
      details: {
        workspaceAgentId: agent.id,
        name: agent.name,
        runtimeBase: spec.runtimeBase,
        modelId: agent.modelId,
      },
    })

    const worker = await this.applyWorkerInstance(input.workspaceId, agent.id)
    stages.push({
      name: 'ApplyWorkerInstance',
      ok: true,
      message: 'WorkerInstance applied and runtime prepared.',
      details: {
        workerInstanceId: worker.workerInstanceId,
        runtimeState: worker.runtimeState,
      },
    })

    const joined = await this.joinRooms(input, agent.id, worker.workerInstanceId, spec.runtimeBase)
    stages.push({
      name: 'JoinRooms',
      ok: true,
      message: joined.participants.length
        ? 'Worker joined requested Matrix rooms.'
        : 'No room join requested.',
      details: {
        groupRoomId: joined.groupRoom?.id ?? null,
        directRoomId: joined.directRoom?.id ?? null,
        participantIds: joined.participants.map((participant) => participant.id),
      },
    })

    const announcements = await this.announceAndObserve({
      announce: input.announce ?? true,
      groupRoomId: joined.groupRoom?.id ?? null,
      agentName: agent.name,
      agentId: agent.id,
      workerInstanceId: worker.workerInstanceId,
      runtimeBase: spec.runtimeBase,
      runtimeState: worker.runtimeState,
    })
    stages.push({
      name: 'AnnounceAndObserve',
      ok: true,
      message: announcements.length
        ? 'Manager announced Worker membership in the room.'
        : 'Announcement skipped or no group room available.',
      details: {
        announcements,
      },
    })

    await this.refreshContractAfterRoomJoin(worker.workerInstanceId, agent.id, spec.runtimeBase)
    await this.workerBackend.syncConfig(worker.workerInstanceId).catch(() => ({
      synced: false,
    }))

    return {
      agentId: agent.id,
      worker: await this.getWorkerResource(worker.workerInstanceId),
      workerInstanceId: worker.workerInstanceId,
      runtimeBase: spec.runtimeBase,
      stages,
      groupRoom: joined.groupRoom,
      directSession: joined.directSession,
      directRoom: joined.directRoom,
      participants: joined.participants,
      announcements,
    }
  }

  private async resolveMemberSpec(input: MemberReconcileInput) {
    const existingAgent = await this.findExistingAgent(input.workspaceId, input.name)
    const runtimeBase = await this.resolveRuntimeBase(input, existingAgent)
    if (runtimeBase === 'openclaw' && !workerContainersEnabled() && !openclawLauncher.isAvailable()) {
      throw new Error(
        'OpenClaw Worker requires a resident backend. Install OpenClaw locally or enable AGENTHUB_WORKER_BACKEND=docker / AGENTHUB_CONTAINER_RUNTIME=docker before creating this Worker.',
      )
    }
    if (runtimeBase === 'qwenpaw' || runtimeBase === 'copaw') {
      throw new Error(
        'QwenPaw Worker runtime is recognized but its WorkerBackend is not implemented yet. Use OpenClaw for resident Workers now, or choose OpenCode / Claude Code / Codex / Gemini bridge.',
      )
    }

    const modelId =
      input.modelId?.trim() ||
      existingAgent?.modelId?.trim() ||
      process.env.AGENTHUB_WORKER_LLM_MODEL?.trim() ||
      process.env.LLM_MODEL?.trim() ||
      null
    if (!modelId) {
      throw new Error(
        'Creating a Worker requires an explicit model binding. Set modelId on the Worker or configure AGENTHUB_WORKER_LLM_MODEL / LLM_MODEL before creation.',
      )
    }

    return {
      existingAgent,
      runtimeBase,
      modelId,
    }
  }

  private async applyWorkspaceAgent(
    input: MemberReconcileInput,
    spec: {
      existingAgent: typeof workspaceAgents.$inferSelect | null
      runtimeBase: WorkerRuntimeBase
      modelId: string
    },
  ) {
    if (spec.existingAgent) {
      const [updated] = await db
        .update(workspaceAgents)
        .set({
          role: (input.role as any) || spec.existingAgent.role || 'worker',
          roleType: (input.roleType as any) || spec.existingAgent.roleType,
          runtimeType: 'code-agent' as any,
          codeAgentType: codeAgentTypeForRuntime(spec.runtimeBase, input.codeAgentType) as any,
          description: input.description ?? spec.existingAgent.description ?? '',
          systemPrompt: input.systemPrompt ?? spec.existingAgent.systemPrompt ?? '',
          roleProfile: workerRoleProfileFromRuntime(spec.runtimeBase, input.roleProfile),
          color: input.color ?? spec.existingAgent.color ?? '#6366f1',
          modelId: spec.modelId,
          capabilityTags: input.capabilityTags ?? spec.existingAgent.capabilityTags ?? [],
          skillIds: input.skillIds ?? spec.existingAgent.skillIds ?? [],
          toolPermissions: input.toolPermissions ?? spec.existingAgent.toolPermissions ?? [],
          sandboxPolicy: (input.sandboxPolicy as any) || spec.existingAgent.sandboxPolicy || 'workspace-write',
          contextPolicy: (input.contextPolicy as any) || spec.existingAgent.contextPolicy || 'workspace-aware',
          autoInvoke: input.autoInvoke ?? spec.existingAgent.autoInvoke ?? true,
          approvalRequired: input.approvalRequired ?? spec.existingAgent.approvalRequired ?? true,
        })
        .where(eq(workspaceAgents.id, spec.existingAgent.id))
        .returning()
      if (!updated) throw new Error('Failed to update workspace agent.')
      return updated
    }

    const [inserted] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        role: (input.role as any) || 'worker',
        roleType: (input.roleType as any) || undefined,
        description: input.description ?? '',
        systemPrompt: input.systemPrompt ?? '',
        runtimeType: 'code-agent' as any,
        codeAgentType: codeAgentTypeForRuntime(spec.runtimeBase, input.codeAgentType) as any,
        roleProfile: workerRoleProfileFromRuntime(spec.runtimeBase, input.roleProfile),
        color: input.color ?? '#6366f1',
        modelId: spec.modelId,
        capabilityTags: input.capabilityTags ?? [],
        skillIds: input.skillIds ?? [],
        toolPermissions: input.toolPermissions ?? [],
        sandboxPolicy: (input.sandboxPolicy as any) || 'workspace-write',
        contextPolicy: (input.contextPolicy as any) || 'workspace-aware',
        autoInvoke: input.autoInvoke ?? true,
        approvalRequired: input.approvalRequired ?? true,
      })
      .returning()
    if (!inserted) throw new Error('Failed to create workspace agent.')
    return inserted
  }

  private async applyWorkerInstance(workspaceId: string, workspaceAgentId: string) {
    const agent = await this.findAgentById(workspaceAgentId)
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new Error(`Workspace Agent ${workspaceAgentId} not found in workspace ${workspaceId}.`)
    }
    const workerInstanceId = await workerController.ensureWorkerForAgent(workspaceId, {
      id: agent.id,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      roleProfile: agent.roleProfile,
      modelId: agent.modelId,
      skillIds: agent.skillIds,
      sandboxPolicy: agent.sandboxPolicy,
    })
    if (!workerInstanceId) throw new Error('WorkerInstance was not created.')

    const runtime = await this.workerBackend.ensureRuntime({
      workerInstanceId,
      context: {
        workspaceId,
      },
    })
    if (!runtime.ready) {
      throw new Error(runtime.message ?? `Worker runtime ${runtime.state ?? 'unknown'} is not ready.`)
    }
    return {
      workerInstanceId,
      runtimeState: runtime.state ?? null,
    }
  }

  private async joinRooms(
    input: MemberReconcileInput,
    workspaceAgentId: string,
    workerInstanceId: string,
    runtimeBase: WorkerRuntimeBase,
  ) {
    const ownerId = await this.resolveOwnerId(input.workspaceId, input.ownerId)
    const participants: Array<typeof roomParticipants.$inferSelect> = []
    let groupRoom: typeof rooms.$inferSelect | null = null
    let directSession: typeof sessions.$inferSelect | null = null
    let directRoom: typeof rooms.$inferSelect | null = null

    if (ownerId && (input.joinGroupRoom || input.groupSessionId)) {
      const groupSession = input.groupSessionId
        ? await this.loadSession(input.groupSessionId, ownerId)
        : await ensureGroupSession(input.workspaceId, ownerId)
      if (groupSession) {
        const ensuredGroupRoom = await roomService.ensureRoomForSession(groupSession.id, ownerId)
        groupRoom = ensuredGroupRoom
        await ensureManagerParticipantForRoom(ensuredGroupRoom.id)
        participants.push(await roomService.addWorkerParticipant(ensuredGroupRoom.id, workspaceAgentId, workerInstanceId))
      }
    }

    if (ownerId && input.createDirectSession) {
      directSession = await this.ensureDirectWorkerSession({
        ownerId,
        workspaceId: input.workspaceId,
        workspaceAgentId,
        title: input.name,
        runtimeBase,
      })
      const ensuredDirectRoom = await roomService.ensureRoomForSession(directSession.id, ownerId)
      directRoom = ensuredDirectRoom
      participants.push(await roomService.addWorkerParticipant(ensuredDirectRoom.id, workspaceAgentId, workerInstanceId))
    }

    return {
      groupRoom,
      directSession,
      directRoom,
      participants,
    }
  }

  private async announceAndObserve(input: {
    announce: boolean
    groupRoomId: string | null
    agentName: string
    agentId: string
    workerInstanceId: string
    runtimeBase: WorkerRuntimeBase
    runtimeState: string | null
  }) {
    if (!input.announce || !input.groupRoomId) return []
    const manager = await ensureManagerParticipantForRoom(input.groupRoomId)
    const event = await roomService.appendTimelineEvent({
      roomId: input.groupRoomId,
      senderParticipantId: manager.id,
      senderType: 'manager',
      type: 'manager.message',
      body: `${input.agentName} 已加入房间，运行基座为 ${input.runtimeBase}。`,
      metadata: {
        kind: 'member-reconcile.announced',
        workspaceAgentId: input.agentId,
        workerInstanceId: input.workerInstanceId,
        runtimeBase: input.runtimeBase,
        runtimeState: input.runtimeState,
        skipAutoDispatch: true,
      },
    })
    return [{ roomId: input.groupRoomId, eventId: event.id }]
  }

  private async refreshContractAfterRoomJoin(
    workerInstanceId: string,
    workspaceAgentId: string,
    runtimeBase: WorkerRuntimeBase,
  ) {
    const agent = await this.findAgentById(workspaceAgentId)
    if (!agent) return
    const currentRooms = await db
      .select({
        roomId: rooms.id,
        roomKind: rooms.kind,
        providerRoomId: rooms.providerRoomId,
        participantId: roomParticipants.id,
        title: rooms.title,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
      .where(and(eq(roomParticipants.workerInstanceId, workerInstanceId), eq(roomParticipants.status, 'joined')))
    await ensureWorkerAgentContract({
      workerInstanceId,
      agent,
      runtimeBase,
      currentRooms,
      controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
      sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
    })
  }

  private async ensureDirectWorkerSession(input: {
    ownerId: string
    workspaceId: string
    workspaceAgentId: string
    title: string
    runtimeBase: WorkerRuntimeBase
  }) {
    const existing = await this.findDirectWorkerSession(input.workspaceId, input.workspaceAgentId)
    if (existing) {
      const [updated] = await db
        .update(sessions)
        .set({
          title: input.title,
          metadata: {
            ...(existing.metadata ?? {}),
            kind: 'agent-direct',
            createdFrom: 'member-reconcile',
            workerRuntimeBase: input.runtimeBase,
          },
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, existing.id))
        .returning()
      return updated ?? existing
    }

    const [created] = await db
      .insert(sessions)
      .values({
        ownerId: input.ownerId,
        title: input.title,
        type: 'direct',
        workspaceId: input.workspaceId,
        workspaceAgentId: input.workspaceAgentId,
        metadata: {
          kind: 'agent-direct',
          createdFrom: 'member-reconcile',
          workerRuntimeBase: input.runtimeBase,
        },
      })
      .returning()
    if (!created) throw new Error('Failed to create Worker direct session.')
    return created
  }

  private async resolveRuntimeBase(
    input: MemberReconcileInput,
    existingAgent: typeof workspaceAgents.$inferSelect | null,
  ) {
    const explicit = normalizeWorkerRuntimeBase(input.runtimeBase ?? input.workerRuntimeBase ?? input.codeAgentType)
    if (explicit) return explicit
    const envDefault = normalizeWorkerRuntimeBase(process.env.AGENTHUB_WORKER_RUNTIME_BASE)
    if (envDefault) return envDefault
    const existingBase = normalizeWorkerRuntimeBase(readWorkerRuntimeBase(existingAgent?.roleProfile) ?? existingAgent?.codeAgentType)
    if (existingBase) return existingBase
    const reusable = await this.findReusableWorkspaceWorkerRuntimeBase(input.workspaceId)
    if (reusable) return reusable
    throw new Error(
      'Creating a Worker requires an explicit worker runtime base. Set runtimeBase/workerRuntimeBase, configure AGENTHUB_WORKER_RUNTIME_BASE, or create/configure an existing Worker base first.',
    )
  }

  private async findReusableWorkspaceWorkerRuntimeBase(workspaceId: string) {
    const agents = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId))
    for (const agent of agents) {
      if (agent.roleType === 'orchestrator') continue
      const base = normalizeWorkerRuntimeBase(readWorkerRuntimeBase(agent.roleProfile) ?? agent.codeAgentType)
      if (base) return base
    }
    return null
  }

  private async findExistingAgent(workspaceId: string, name: string) {
    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.name, name)))
      .limit(1)
    return agent ?? null
  }

  private async findAgentById(workspaceAgentId: string) {
    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, workspaceAgentId))
      .limit(1)
    return agent ?? null
  }

  private async resolveOwnerId(workspaceId: string, ownerId?: string | null) {
    if (ownerId) return ownerId
    const [workspace] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return workspace?.ownerId ?? null
  }

  private async loadSession(sessionId: string, ownerId: string) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
      .limit(1)
    return session ?? null
  }

  private async findDirectWorkerSession(workspaceId: string, workspaceAgentId: string) {
    const items = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.workspaceAgentId, workspaceAgentId)))
    return items.find((session) => {
      const metadata = session.metadata ?? {}
      return session.type === 'direct' && metadata.kind === 'agent-direct'
    }) ?? null
  }

  private async getWorkerResource(workerInstanceId: string): Promise<MemberReconcileResult['worker']> {
    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, workerInstanceId))
      .limit(1)
    if (!worker) return null
    return {
      apiVersion: 'agenthub.dev/v1alpha1',
      kind: 'Worker',
      metadata: {
        id: worker.id,
        workspaceId: worker.workspaceId,
        generation: Number(worker.updatedAt?.getTime?.() ?? 1),
        createdAt: worker.createdAt?.toISOString?.() ?? null,
        updatedAt: worker.updatedAt?.toISOString?.() ?? null,
      },
      spec: {
        workspaceAgentId: worker.workspaceAgentId,
        runtimeFamily: worker.runtimeFamily,
        runtimeBase: worker.runtimeBase,
        modelId: worker.modelId,
        skillIds: worker.skillIds,
        sandboxPolicy: worker.sandboxPolicy,
        desiredState: worker.desiredState,
      },
      status: {
        observedGeneration: Number(worker.updatedAt?.getTime?.() ?? 1),
        desiredState: worker.desiredState,
        observedState: worker.observedState,
        health: worker.health,
        runtimeHome: worker.runtimeHome,
        runtimeConfigPath: worker.runtimeConfigPath,
        lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString?.() ?? null,
        message: worker.message,
        conditions: [
          condition('Ready', isReadyWorkerState(worker.observedState) ? 'true' : 'false', {
            reason: worker.observedState,
            message: worker.message,
          }),
        ],
      },
    }
  }
}

function isReadyWorkerState(state: string): boolean {
  return state === 'ready' || state === 'listening' || state === 'assigned' || state === 'busy' || state === 'idle'
}
