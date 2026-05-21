const API_BASE = '/api'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface Session {
  id: string
  ownerId: string
  title: string
  type: 'direct' | 'group'
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  sessionId: string
  senderId: string
  senderType: 'user' | 'agent' | 'system'
  type: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface ModelCatalogItem {
  id: string
  enabled: boolean
  name: string
  provider: string
  modelId: string
  apiEndpoint: string
  anthropicEndpoint?: string
  apiKeyEnv?: string
  apiKey?: string
}

export interface CodingToolStatus {
  id: string
  command: string
  installed: boolean
  version: string | null
}

export const api = {
  // Sessions
  listSessions: () => request<{ items: Session[] }>('/sessions'),
  createSession: (data: { title: string; type?: 'direct' | 'group' }) =>
    request<Session>('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  // Messages
  listMessages: (sessionId: string) =>
    request<{ items: Message[] }>(`/messages/${sessionId}`),
  sendMessage: (sessionId: string, data: { content: string; type?: string }) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ content: data.content, type: data.type ?? 'text' }),
    }),

  sendMessageWithModel: (sessionId: string, data: { content: string; modelId?: string; type?: string }) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: data.content,
        type: data.type ?? 'text',
        metadata: data.modelId ? { modelId: data.modelId } : undefined,
      }),
    }),

  // Settings (map-based)
  getSettings: () => request<Record<string, string>>('/settings'),
  saveSettings: (data: Record<string, string>) =>
    request<{ success: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  testModel: (data: {
    provider: string
    apiEndpoint: string
    anthropicEndpoint?: string
    apiKey?: string
    apiKeyEnv?: string
  }) =>
    request<{ ok: boolean; status?: number; message: string }>('/settings/test-model', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Coding tools
  getCodingToolStatus: () =>
    request<{ platform: string; items: CodingToolStatus[] }>('/coding-tools/status'),
}
