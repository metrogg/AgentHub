import { API_BASE, request } from './apiClient'
import type {
  AgentConfigEditResult,
  AgentConfigEditStreamEvent,
  AgentConfigInput,
  LoadedSkill,
  SkillhubSearchResult,
  SkillInstallResult,
  SkillSummary,
} from './apiTypes'

export const agentConfigApi = {
  // Skills
  listSkills: () => request<{ items: SkillSummary[] }>('/skills'),
  getSkill: (id: string) => request<LoadedSkill>(`/skills/${encodeURIComponent(id)}`),
  installSkill: (data: { sourceUrl: string; id?: string }) =>
    request<SkillInstallResult>('/skills/install', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  searchSkillhub: (q: string) =>
    request<SkillhubSearchResult>(`/skills/skillhub/search?q=${encodeURIComponent(q)}`),
  installSkillhub: (slug: string) =>
    request<SkillInstallResult>('/skills/skillhub/install', {
      method: 'POST',
      body: JSON.stringify({ slug }),
    }),
  editAgentConfig: async function* (
    draft: AgentConfigInput,
    instruction: string,
  ): AsyncGenerator<AgentConfigEditStreamEvent> {
    const res = await fetch(`${API_BASE}/agent-config/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ draft, instruction }),
    })
    if (!res.ok) throw new Error(`Agent 配置修改失败: ${res.status}`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = 'message'
    let dataLines: string[] = []

    const flushEvent = (): AgentConfigEditStreamEvent | null => {
      const data = dataLines.join('\n')
      eventName = eventName || 'message'
      dataLines = []
      if (eventName === 'done') return null
      if (eventName === 'error') throw new Error(data || 'Agent 配置修改失败')
      if (!data) return null
      if (eventName === 'result') {
        return { type: 'result', result: JSON.parse(data) as AgentConfigEditResult }
      }
      return { type: 'chunk', text: data }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line) {
          const event = flushEvent()
          eventName = 'message'
          if (event) yield event
          continue
        }
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6))
        }
      }
    }
    if (buffer || dataLines.length) {
      const event = flushEvent()
      if (event) yield event
    }
  },
}
