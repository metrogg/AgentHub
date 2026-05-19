import { api } from './client'

export async function fetchMessages(sessionId: string) {
  const res = await api.api.messages[':sessionId'].$get({ param: { sessionId } })
  const data = await res.json()
  return (data as any).items ?? []
}

export async function sendMessage(sessionId: string, content: string, type: 'text' | 'markdown' = 'text') {
  const res = await api.api.messages[':sessionId'].$post({
    param: { sessionId },
    json: { content, type, mentions: [] },
  })
  return res.json()
}
