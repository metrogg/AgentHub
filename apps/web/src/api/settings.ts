import { apiFetch } from './client'

export async function fetchSettings(): Promise<Record<string, string>> {
  const res = await apiFetch('/api/settings')
  return res.json() as Promise<Record<string, string>>
}

export async function saveSettings(body: Record<string, string>) {
  const res = await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return res.json()
}
