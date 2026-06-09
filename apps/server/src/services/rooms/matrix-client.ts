import { randomUUID } from 'node:crypto'

const matrixEventMetadataKey = 'org.agenthub.metadata'
// Matrix homeservers validate the full PDU, not just the client request body.
// Keep content comfortably below 64KB so server-added event fields still fit.
const matrixSafeEventBytes = 48_000
const matrixTextBodyBudgetBytes = 36_000
const matrixMentionBodyBudgetBytes = 20_000
const matrixCompactMetadataBudgetBytes = 10_000
const matrixTruncationNotice =
  '\n\n[AgentHub: Matrix event was truncated; full content is preserved in the local AgentHub timeline.]'
const matrixTextEncoder = new TextEncoder()

export interface MatrixClientOptions {
  homeserverUrl: string
  serverName: string
  adminAccessToken?: string
  adminRoomAlias?: string
  registrationToken?: string
  autoInviteParticipants: boolean
  autoJoinParticipants: boolean
}

export interface MatrixRequestAuth {
  accessToken?: string | null
}

export interface EnsureMatrixUserResult {
  userId: string
  accessToken: string
  password: string
  created: boolean
}

export interface MatrixSyncRoomEvent {
  type: string
  event_id?: string
  sender?: string
  origin_server_ts?: number
  content?: Record<string, unknown>
}

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, {
      timeline?: {
        events?: MatrixSyncRoomEvent[]
        limited?: boolean
        prev_batch?: string
      }
    }>
  }
}

export interface MatrixMediaDownloadResult {
  bytes: Uint8Array
  contentType: string | null
  contentDisposition: string | null
  fileName: string | null
  endpoint: string
}

export class MatrixClient {
  constructor(private readonly options: MatrixClientOptions) {}

  get serverName() {
    return this.options.serverName
  }

  get homeserverUrl() {
    return this.options.homeserverUrl
  }

  shouldAutoInviteParticipants() {
    return this.options.autoInviteParticipants
  }

  shouldAutoJoinParticipants() {
    return this.options.autoJoinParticipants
  }

  async versions() {
    return this.request<{
      versions?: string[]
      unstable_features?: Record<string, boolean>
    }>('/_matrix/client/versions', {
      method: 'GET',
    })
  }

  userId(localpart: string) {
    return `@${localpart}:${this.options.serverName}`
  }

  async ensureUser(input: { localpart: string; password: string; displayName: string }): Promise<EnsureMatrixUserResult> {
    const userId = this.userId(input.localpart)
    try {
      const registered = await this.registerUser({
        username: input.localpart,
        password: input.password,
      })
      await this.setDisplayName(registered.access_token, registered.user_id, input.displayName).catch(() => undefined)
      return {
        userId: registered.user_id,
        accessToken: registered.access_token,
        password: input.password,
        created: true,
      }
    } catch (error) {
      if (!isUserAlreadyExists(error)) throw error
    }

    let login: { user_id: string; access_token: string }
    try {
      login = await this.login(input.localpart, input.password)
    } catch (loginError) {
      await this.resetPasswordViaAdmin(userId, input.password, loginError)
      login = await this.loginAfterAdminRecovery(input.localpart, input.password)
    }
    await this.setDisplayName(login.access_token, login.user_id, input.displayName).catch(() => undefined)
    return {
      userId: login.user_id || userId,
      accessToken: login.access_token,
      password: input.password,
      created: false,
    }
  }

  async registerUser(input: { username: string; password: string }) {
    const auth = this.options.registrationToken
      ? {
          type: 'm.login.registration_token',
          token: this.options.registrationToken,
        }
      : undefined
    return this.request<{ user_id: string; access_token: string }>('/_matrix/client/v3/register', {
      method: 'POST',
      body: {
        username: input.username,
        password: input.password,
        auth,
      },
    })
  }

  async login(username: string, password: string) {
    return this.request<{ user_id: string; access_token: string }>('/_matrix/client/v3/login', {
      method: 'POST',
      body: {
        type: 'm.login.password',
        identifier: {
          type: 'm.id.user',
          user: username,
        },
        password,
      },
    })
  }

  async setDisplayName(accessToken: string, userId: string, displayName: string) {
    return this.request<Record<string, never>>(
      `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
      {
        method: 'PUT',
        accessToken,
        body: { displayname: displayName },
      },
    )
  }

  async createRoom(input: {
    name: string
    topic?: string | null
    aliasName?: string | null
    invite?: string[]
    accessToken?: string | null
  }) {
    return this.request<{ room_id: string }>('/_matrix/client/v3/createRoom', {
      method: 'POST',
      accessToken: input.accessToken,
      body: {
        name: input.name,
        topic: input.topic ?? undefined,
        room_alias_name: input.aliasName || undefined,
        preset: 'trusted_private_chat',
        invite: input.invite?.length ? input.invite : undefined,
        visibility: 'private',
      },
    })
  }

  async resolveRoomAlias(alias: string, auth: MatrixRequestAuth = {}) {
    return this.request<{ room_id: string; servers?: string[] }>(
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      {
        method: 'GET',
        accessToken: auth.accessToken,
      },
    )
  }

  async inviteUser(roomId: string, userId: string, auth: MatrixRequestAuth = {}) {
    return this.request<Record<string, never>>(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST',
      accessToken: auth.accessToken,
      body: { user_id: userId },
    })
  }

  async joinRoom(roomIdOrAlias: string, accessToken: string) {
    return this.request<{ room_id: string }>(`/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`, {
      method: 'POST',
      accessToken,
      body: {},
    })
  }

  async listRoomMembers(roomId: string, auth: MatrixRequestAuth = {}) {
    return this.request<{ chunk: Array<{ state_key?: string; content?: { membership?: string } }> }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
      {
        method: 'GET',
        accessToken: auth.accessToken,
      },
    )
  }

  async sync(input: { accessToken: string; since?: string | null; timeoutMs?: number }) {
    const params = new URLSearchParams()
    if (input.since) params.set('since', input.since)
    params.set('timeout', String(Math.max(0, input.timeoutMs ?? 0)))
    return this.request<MatrixSyncResponse>(`/_matrix/client/v3/sync?${params.toString()}`, {
      method: 'GET',
      accessToken: input.accessToken,
    })
  }

  async downloadMedia(
    input: { mxcUrl: string; fileName?: string | null },
    auth: MatrixRequestAuth = {},
  ): Promise<MatrixMediaDownloadResult> {
    const media = parseMxcUrl(input.mxcUrl)
    const filenamePart = input.fileName ? `/${encodeURIComponent(input.fileName)}` : ''
    const modernPath =
      `/_matrix/client/v1/media/download/${encodeURIComponent(media.serverName)}/${encodeURIComponent(media.mediaId)}${filenamePart}`
    const legacyPath =
      `/_matrix/media/v3/download/${encodeURIComponent(media.serverName)}/${encodeURIComponent(media.mediaId)}${filenamePart}`

    try {
      return await this.downloadMediaFromPath(modernPath, auth)
    } catch (error) {
      if (!shouldTryLegacyMediaDownload(error)) throw error
      return this.downloadMediaFromPath(legacyPath, auth)
    }
  }

  async sendTextMessage(
    roomId: string,
    body: string,
    metadata: Record<string, unknown>,
    auth: MatrixRequestAuth = {},
  ) {
    const txId = `agenthub-${randomUUID()}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txId)}`,
      {
        method: 'PUT',
        accessToken: auth.accessToken,
        body: fitMatrixMessageContent({
          msgtype: 'm.text',
          body,
          [matrixEventMetadataKey]: metadata,
        }),
      },
    )
  }

  async sendMentionMessage(
    roomId: string,
    input: {
      body: string
      mentionUserId: string
      mentionDisplayName?: string
      metadata?: Record<string, unknown>
    },
    auth: MatrixRequestAuth = {},
  ) {
    const txId = `agenthub-${randomUUID()}`
    const linkLabel = input.mentionDisplayName || input.mentionUserId
    const mentionHtml = `<a href="https://matrix.to/#/${escapeHtml(input.mentionUserId)}">${escapeHtml(linkLabel)}</a>`
    const mentionBody = truncateUtf8(input.body, matrixMentionBodyBudgetBytes)
    const visibleBody = `@${linkLabel.replace(/^@/, '')} ${mentionBody}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txId)}`,
      {
        method: 'PUT',
        accessToken: auth.accessToken,
        body: fitMatrixMessageContent({
          msgtype: 'm.text',
          body: visibleBody,
          format: 'org.matrix.custom.html',
          formatted_body: `${mentionHtml} ${escapeHtml(mentionBody)}`,
          'm.mentions': {
            user_ids: [input.mentionUserId],
          },
          [matrixEventMetadataKey]: input.metadata ?? {},
        }),
      },
    )
  }

  async adminCommand(command: string) {
    const roomAlias = this.options.adminRoomAlias || `#admins:${this.options.serverName}`
    const room = await this.resolveRoomAlias(roomAlias, { accessToken: this.options.adminAccessToken })
    await this.sendTextMessage(room.room_id, command, { kind: 'matrix.admin-command' }, {
      accessToken: this.options.adminAccessToken,
    })
  }

  async resetPasswordViaAdmin(userId: string, password: string, loginError: unknown) {
    if (!this.options.adminAccessToken) {
      throw new Error(
        `Matrix user ${userId} already exists but login failed and no admin access token is configured for reset-password recovery: ${
          loginError instanceof Error ? loginError.message : String(loginError)
        }`,
      )
    }
    await this.adminCommand(`!admin users reset-password ${userId} ${password}`)
  }

  private async loginAfterAdminRecovery(username: string, password: string) {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (attempt > 1) await sleep(250 * attempt)
      try {
        return await this.login(username, password)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(
      `Matrix user ${username} reset-password recovery was issued but login still failed: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; accessToken?: string | null },
  ): Promise<T> {
    const token = init.accessToken ?? this.options.adminAccessToken
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(`${this.options.homeserverUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new MatrixApiError(
        `Matrix API ${init.method} ${path} failed: ${response.status} ${text.slice(0, 500)}`,
        response.status,
        text,
      )
    }
    if (response.status === 204) return {} as T
    return response.json() as Promise<T>
  }

  private async downloadMediaFromPath(path: string, auth: MatrixRequestAuth): Promise<MatrixMediaDownloadResult> {
    const response = await this.rawRequest(path, {
      method: 'GET',
      accessToken: auth.accessToken,
      accept: '*/*',
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      contentType: response.headers.get('content-type'),
      contentDisposition: response.headers.get('content-disposition'),
      fileName: fileNameFromContentDisposition(response.headers.get('content-disposition')),
      endpoint: path,
    }
  }

  private async rawRequest(
    path: string,
    init: { method: string; body?: string | Uint8Array; accessToken?: string | null; accept?: string },
  ): Promise<Response> {
    const token = init.accessToken ?? this.options.adminAccessToken
    const headers: Record<string, string> = {}
    if (init.accept) headers.Accept = init.accept
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(`${this.options.homeserverUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers,
      body: init.body,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new MatrixApiError(
        `Matrix API ${init.method} ${path} failed: ${response.status} ${text.slice(0, 500)}`,
        response.status,
        text,
      )
    }
    return response
  }
}

export class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message)
    this.name = 'MatrixApiError'
  }
}

function isUserAlreadyExists(error: unknown) {
  if (!(error instanceof MatrixApiError)) return false
  return error.status === 400 && /M_USER_IN_USE|User ID already taken|already exists/i.test(error.responseBody)
}

function shouldTryLegacyMediaDownload(error: unknown) {
  if (!(error instanceof MatrixApiError)) return false
  return error.status === 404 || error.status === 405 || error.status === 501
}

function parseMxcUrl(mxcUrl: string) {
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid Matrix media URI: ${mxcUrl}`)
  }
  return {
    serverName: decodeURIComponent(match[1]),
    mediaId: decodeURIComponent(match[2]),
  }
}

function fileNameFromContentDisposition(value: string | null) {
  if (!value) return null
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1])
  const asciiMatch = value.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] ?? null
}

function fitMatrixMessageContent(content: Record<string, unknown>) {
  if (jsonByteLength(content) <= matrixSafeEventBytes) return content

  const body = readString(content.body)
  const formattedBody = readString(content.formatted_body)
  const metadata = readRecord(content[matrixEventMetadataKey])
  const compactMetadata = compactMatrixMetadata(metadata, {
    originalBodyBytes: body ? utf8ByteLength(body) : 0,
    originalFormattedBodyBytes: formattedBody ? utf8ByteLength(formattedBody) : 0,
    originalMetadataBytes: jsonByteLength(metadata),
  })

  const next: Record<string, unknown> = {
    ...content,
    [matrixEventMetadataKey]: compactMetadata,
  }

  const initialBodyBudget = formattedBody ? matrixMentionBodyBudgetBytes : matrixTextBodyBudgetBytes
  if (body) next.body = truncateUtf8(body, initialBodyBudget)
  if (formattedBody) next.formatted_body = truncateUtf8(formattedBody, matrixMentionBodyBudgetBytes)
  if (jsonByteLength(next) <= matrixSafeEventBytes) return next

  for (const budget of [16_000, 8_000, 4_000, 2_000]) {
    if (body) next.body = truncateUtf8(body, formattedBody ? Math.floor(budget / 2) : budget)
    if (formattedBody) next.formatted_body = truncateUtf8(formattedBody, Math.floor(budget / 2))
    if (jsonByteLength(next) <= matrixSafeEventBytes) return next
  }

  delete next.format
  delete next.formatted_body
  if (body) next.body = truncateUtf8(body, 2_000)
  next[matrixEventMetadataKey] = {
    matrixPayloadTruncated: true,
    originalBodyBytes: body ? utf8ByteLength(body) : 0,
    originalFormattedBodyBytes: formattedBody ? utf8ByteLength(formattedBody) : 0,
    originalMetadataBytes: jsonByteLength(metadata),
  }
  return next
}

function compactMatrixMetadata(
  metadata: Record<string, unknown>,
  truncation: {
    originalBodyBytes: number
    originalFormattedBodyBytes: number
    originalMetadataBytes: number
  },
) {
  const compact: Record<string, unknown> = {}
  const keepKeys = new Set([
    'kind',
    'type',
    'status',
    'source',
    'senderType',
    'eventType',
    'senderParticipantId',
    'sentAsMatrixUserId',
    'mentionParticipantId',
    'mentionUserId',
    'workspaceId',
    'workspaceAgentId',
    'workerInstanceId',
    'orchestratorRunId',
    'orchestratorTaskId',
    'taskThreadId',
    'taskId',
    'runId',
    'traceId',
    'messageId',
    'sourceMessageId',
    'sourceEventId',
    'clarificationId',
    'clarificationQuestion',
    'control',
  ])

  for (const [key, value] of Object.entries(metadata)) {
    if (!keepKeys.has(key)) continue
    const compactValue = compactMatrixMetadataValue(value)
    if (compactValue !== undefined) compact[key] = compactValue
  }

  compact.matrixPayloadTruncated = {
    ...truncation,
    fullContentLocation: 'local-agenthub-timeline',
  }

  if (jsonByteLength(compact) <= matrixCompactMetadataBudgetBytes) return compact

  for (const [key, value] of Object.entries(compact)) {
    if (typeof value === 'string') compact[key] = truncateUtf8(value, 256, '')
  }
  if (jsonByteLength(compact) <= matrixCompactMetadataBudgetBytes) return compact

  return {
    kind: compact.kind,
    type: compact.type,
    senderType: compact.senderType,
    eventType: compact.eventType,
    senderParticipantId: compact.senderParticipantId,
    traceId: compact.traceId,
    matrixPayloadTruncated: compact.matrixPayloadTruncated,
  }
}

function compactMatrixMetadataValue(value: unknown): unknown {
  if (value === null) return null
  if (typeof value === 'string') return truncateUtf8(value, 512, '')
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 20)
      .map(compactMatrixMetadataValue)
      .filter((item) => item !== undefined)
    return items.length ? items : undefined
  }
  return undefined
}

function truncateUtf8(value: string, maxBytes: number, notice = matrixTruncationNotice) {
  if (utf8ByteLength(value) <= maxBytes) return value
  const noticeBytes = utf8ByteLength(notice)
  const targetBytes = Math.max(0, maxBytes - noticeBytes)
  const chars = Array.from(value)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(chars.slice(0, mid).join('')) <= targetBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return `${chars.slice(0, low).join('')}${notice}`
}

function jsonByteLength(value: unknown) {
  return utf8ByteLength(JSON.stringify(value) ?? '')
}

function utf8ByteLength(value: string) {
  return matrixTextEncoder.encode(value).length
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function matrixBool(name: string, defaultValue: boolean) {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  return defaultValue
}

export function matrixLocalpart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/:.+$/, '')
      .replace(/[^a-z0-9._=-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'participant'
  )
}

export function createMatrixClientFromEnv() {
  const homeserverUrl = process.env.AGENTHUB_MATRIX_HOMESERVER_URL
  const serverName = process.env.AGENTHUB_MATRIX_SERVER_NAME ?? 'agenthub.local'
  if (!homeserverUrl) {
    throw new Error('Matrix client requires AGENTHUB_MATRIX_HOMESERVER_URL')
  }
  return new MatrixClient({
    homeserverUrl,
    serverName,
    adminAccessToken: process.env.AGENTHUB_MATRIX_ACCESS_TOKEN,
    adminRoomAlias: process.env.AGENTHUB_MATRIX_ADMIN_ROOM_ALIAS,
    registrationToken: process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN?.trim() || undefined,
    autoInviteParticipants: matrixBool('AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS', true),
    autoJoinParticipants: matrixBool('AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS', true),
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
