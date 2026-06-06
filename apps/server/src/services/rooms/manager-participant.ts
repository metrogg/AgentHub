import { and, asc, db, eq, roomParticipants, rooms, workspaceAgents } from '@agenthub/db'
import { roomService } from './room-service'

type RoomParticipantRow = typeof roomParticipants.$inferSelect
type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

export async function ensureManagerParticipantForRoom(roomId: string) {
  const managerAgent = await resolveRoomManagerAgent(roomId)
  if (managerAgent) return ensureManagerParticipantBoundToAgent(roomId, managerAgent)
  return ensureGenericManagerParticipant(roomId)
}

export async function resolveRoomManagerAgent(roomId: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
  if (!room?.workspaceId) return null
  return resolveWorkspaceManagerAgent(room.workspaceId)
}

export async function resolveWorkspaceManagerAgent(workspaceId: string) {
  const [agent] = await db
    .select()
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
    .limit(1)
  return agent ?? null
}

async function ensureManagerParticipantBoundToAgent(roomId: string, agent: WorkspaceAgentRow) {
  const existing = await findExistingManagerParticipant(roomId)
  const metadata = managerParticipantMetadata(agent, existing)

  if (existing) {
    await db
      .update(roomParticipants)
      .set({
        workspaceAgentId: agent.id,
        displayName: agent.name,
        role: 'manager',
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(roomParticipants.id, existing.id))
  }

  return roomService.addParticipant({
    roomId,
    participantType: 'manager',
    workspaceAgentId: agent.id,
    displayName: agent.name,
    role: 'manager',
    metadata,
  })
}

async function ensureGenericManagerParticipant(roomId: string) {
  const existing = await findExistingManagerParticipant(roomId)
  if (existing) return existing
  return roomService.addParticipant({
    roomId,
    participantType: 'manager',
    displayName: 'Manager',
    role: 'manager',
    metadata: {
      identityKind: 'generic-manager',
    },
  })
}

async function findExistingManagerParticipant(roomId: string): Promise<RoomParticipantRow | null> {
  const [existing] = await db
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantType, 'manager')))
    .limit(1)
  return existing ?? null
}

function managerParticipantMetadata(agent: WorkspaceAgentRow, existing?: RoomParticipantRow | null) {
  return {
    ...(existing?.metadata ?? {}),
    identityKind: 'workspace-orchestrator-manager',
    managerAgentId: agent.id,
    roleType: agent.roleType,
    managerDisplayRole: agent.role,
    color: agent.color,
    avatar: agent.avatar,
  }
}
