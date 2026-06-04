import { randomBytes } from 'node:crypto'
import { and, db, eq, matrixIdentities } from '@agenthub/db'
import type { ParticipantType } from './types'
import { MatrixClient, matrixLocalpart } from './matrix-client'

export interface MatrixIdentityOwner {
  ownerType: ParticipantType
  ownerId: string
  displayName: string
}

export class MatrixIdentityService {
  constructor(private readonly client: MatrixClient) {}

  async ensureIdentity(input: MatrixIdentityOwner) {
    const localpart = localpartForOwner(input)
    const userId = this.client.userId(localpart)
    const [existing] = await db
      .select()
      .from(matrixIdentities)
      .where(
        and(
          eq(matrixIdentities.ownerType, input.ownerType),
          eq(matrixIdentities.ownerId, input.ownerId),
          eq(matrixIdentities.serverName, this.client.serverName),
        ),
      )
      .limit(1)

    if (existing?.accessToken && existing.password) {
      return existing
    }

    const password = existing?.password || generatedMatrixPassword()
    const ensured = await this.client.ensureUser({
      localpart,
      password,
      displayName: input.displayName,
    })

    if (existing) {
      const [updated] = await db
        .update(matrixIdentities)
        .set({
          localpart,
          userId: ensured.userId,
          accessToken: ensured.accessToken,
          password,
          displayName: input.displayName,
          metadata: {
            ...(existing.metadata ?? {}),
            lastEnsureCreatedUser: ensured.created,
            homeserverUrl: this.client.homeserverUrl,
          },
          updatedAt: new Date(),
        })
        .where(eq(matrixIdentities.id, existing.id))
        .returning()
      return updated ?? existing
    }

    const [created] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        serverName: this.client.serverName,
        localpart,
        userId: ensured.userId || userId,
        accessToken: ensured.accessToken,
        password,
        displayName: input.displayName,
        metadata: {
          lastEnsureCreatedUser: ensured.created,
          homeserverUrl: this.client.homeserverUrl,
        },
      })
      .returning()
    if (!created) throw new Error('Matrix identity create failed')
    return created
  }

}

export function identityOwnerFromParticipant(input: {
  participantType: ParticipantType
  userId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  displayName: string
}) {
  const fallbackOwnerId =
    input.participantType === 'manager'
      ? 'manager'
      : input.participantType === 'system'
        ? 'system'
        : `${input.participantType}-${matrixLocalpart(input.displayName)}`
  return {
    ownerType: input.participantType,
    ownerId:
      input.userId ??
      input.workspaceAgentId ??
      input.workerInstanceId ??
      fallbackOwnerId,
    displayName: input.displayName,
  } satisfies MatrixIdentityOwner
}

export function localpartForOwner(input: MatrixIdentityOwner) {
  const suffix = matrixLocalpart(input.ownerId || input.displayName)
  if (input.ownerType === 'human') return `human-${suffix}`
  if (input.ownerType === 'manager') return `manager-${suffix}`
  if (input.ownerType === 'system') return `system-${suffix}`
  return `worker-${suffix}`
}

function generatedMatrixPassword() {
  return `agenthub-${randomBytes(24).toString('base64url')}`
}
