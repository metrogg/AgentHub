import { apiFetch } from './client'

export async function fetchMessages(sessionId: string) {
  const res = await apiFetch(`/api/messages/${sessionId}`)
  const data = await res.json()
  return (data as any).items ?? []
}

export async function sendMessage(
  sessionId: string,
  content: string,
  type: 'text' | 'markdown' = 'text',
) {
  const res = await apiFetch(`/api/messages/${sessionId}`, {
    method: 'POST',
    body: JSON.stringify({ content, type, mentions: [] }),
  })
  return res.json()
}
