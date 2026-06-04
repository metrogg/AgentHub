import { randomUUID } from 'node:crypto'

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
        body: {
          msgtype: 'm.text',
          body,
          'org.agenthub.metadata': metadata,
        },
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
    const visibleBody = `${input.mentionUserId} ${input.body}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txId)}`,
      {
        method: 'PUT',
        accessToken: auth.accessToken,
        body: {
          msgtype: 'm.text',
          body: visibleBody,
          format: 'org.matrix.custom.html',
          formatted_body: `${mentionHtml} ${escapeHtml(input.body)}`,
          'm.mentions': {
            user_ids: [input.mentionUserId],
          },
          'org.agenthub.metadata': input.metadata ?? {},
        },
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
