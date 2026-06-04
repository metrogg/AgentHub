import { db, eq, matrixIdentities, roomParticipants, rooms } from '@agenthub/db'
import { createMatrixClientFromEnv, MatrixApiError, matrixBool } from './matrix-client'
import { matrixRuntimeListener } from './matrix-runtime-listener'

export interface MatrixDiagnostics {
  provider: string
  configured: boolean
  homeserver: {
    url: string | null
    serverName: string
    reachable: boolean
    versions: string[]
    error: string | null
  }
  registration: {
    tokenConfigured: boolean
    adminAccessTokenConfigured: boolean
    adminRoomAliasConfigured: boolean
    autoInviteParticipants: boolean
    autoJoinParticipants: boolean
  }
  resources: {
    matrixRoomCount: number
    activeMatrixRoomCount: number
    identityCount: number
    identityWithTokenCount: number
    backendParticipantCount: number
    joinedBackendParticipantCount: number
  }
  listeners: {
    runningIdentityIds: string[]
    rows: Array<{
      identityId: string
      userId: string
      ownerType: string
      ownerId: string
      runningInMemory: boolean
      lastSyncedAt: string | null
      lastOkAt: string | null
      lastErrorAt: string | null
      lastError: string | null
      consecutiveErrors: number
    }>
  }
}

export async function describeMatrixDiagnostics(): Promise<MatrixDiagnostics> {
  const provider = process.env.AGENTHUB_ROOM_PROVIDER?.trim() || 'matrix'
  const homeserverUrl = process.env.AGENTHUB_MATRIX_HOMESERVER_URL?.trim() || null
  const serverName = process.env.AGENTHUB_MATRIX_SERVER_NAME?.trim() || 'agenthub.local'
  const configured = provider === 'matrix' && Boolean(homeserverUrl)

  const [homeserver, resources, listeners] = await Promise.all([
    probeHomeserver(configured),
    describeMatrixResources(),
    describeMatrixListeners(),
  ])

  return {
    provider,
    configured,
    homeserver: {
      url: homeserverUrl,
      serverName,
      ...homeserver,
    },
    registration: {
      tokenConfigured: Boolean(process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN?.trim()),
      adminAccessTokenConfigured: Boolean(process.env.AGENTHUB_MATRIX_ACCESS_TOKEN?.trim()),
      adminRoomAliasConfigured: Boolean(process.env.AGENTHUB_MATRIX_ADMIN_ROOM_ALIAS?.trim()),
      autoInviteParticipants: matrixBool('AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS', true),
      autoJoinParticipants: matrixBool('AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS', true),
    },
    resources,
    listeners,
  }
}

async function probeHomeserver(configured: boolean) {
  if (!configured) {
    return {
      reachable: false,
      versions: [],
      error: 'Matrix provider is not fully configured.',
    }
  }
  try {
    const versions = await createMatrixClientFromEnv().versions()
    return {
      reachable: true,
      versions: versions.versions ?? [],
      error: null,
    }
  } catch (error) {
    return {
      reachable: false,
      versions: [],
      error: matrixErrorMessage(error),
    }
  }
}

async function describeMatrixResources() {
  const [matrixRoomRows, identityRows, participantRows] = await Promise.all([
    db.select().from(rooms).where(eq(rooms.provider, 'matrix')),
    db.select().from(matrixIdentities),
    db.select().from(roomParticipants),
  ])
  const backendParticipants = participantRows.filter((participant) =>
    participant.participantType === 'manager' || participant.participantType === 'worker',
  )
  return {
    matrixRoomCount: matrixRoomRows.length,
    activeMatrixRoomCount: matrixRoomRows.filter((room) => room.status === 'active').length,
    identityCount: identityRows.length,
    identityWithTokenCount: identityRows.filter((identity) => Boolean(identity.accessToken)).length,
    backendParticipantCount: backendParticipants.length,
    joinedBackendParticipantCount: backendParticipants.filter((participant) => participant.status === 'joined').length,
  }
}

async function describeMatrixListeners() {
  const runningIdentityIds = matrixRuntimeListener.getRunningIdentityIds()
  const identities = await db.select().from(matrixIdentities)
  return {
    runningIdentityIds,
    rows: identities
      .map((identity) => {
        const sync = matrixSyncState(identity.metadata)
        return {
          identityId: identity.id,
          userId: identity.userId,
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          runningInMemory: runningIdentityIds.includes(identity.id),
          lastSyncedAt: sync.lastSyncedAt ?? null,
          lastOkAt: sync.lastOkAt ?? null,
          lastErrorAt: sync.lastErrorAt ?? null,
          lastError: sync.lastError ?? null,
          consecutiveErrors: sync.consecutiveErrors ?? 0,
        }
      })
      .sort((a, b) => Number(b.runningInMemory) - Number(a.runningInMemory) || a.userId.localeCompare(b.userId)),
  }
}

function matrixSyncState(metadata: Record<string, unknown> | null | undefined) {
  const state = metadata?.matrixSync
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {}
  const value = state as Record<string, unknown>
  return {
    lastSyncedAt: typeof value.lastSyncedAt === 'string' ? value.lastSyncedAt : null,
    lastOkAt: typeof value.lastOkAt === 'string' ? value.lastOkAt : null,
    lastErrorAt: typeof value.lastErrorAt === 'string' ? value.lastErrorAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    consecutiveErrors: typeof value.consecutiveErrors === 'number' ? value.consecutiveErrors : 0,
  }
}

function matrixErrorMessage(error: unknown) {
  if (error instanceof MatrixApiError) {
    return `${error.status}: ${error.responseBody.slice(0, 300)}`
  }
  return error instanceof Error ? error.message : String(error)
}
