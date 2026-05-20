import { hc } from 'hono/client'
import type { AppType } from '@agenthub/server'

const raw = import.meta.env.VITE_API_URL ?? ''
const configuredBaseURL = raw.replace(/\/$/, '').replace(/\/api$/, '') || 'http://localhost:8000'
const API_BASE_STORAGE_KEY = 'agenthub.apiBaseURL'

export const api = hc<AppType>(configuredBaseURL, {
  headers: authHeaders,
})

export type Api = typeof api

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function candidateBaseURLs() {
  const configured = configuredBaseURL.replace(/\/$/, '')
  const configuredURL = new URL(configured)
  const protocol = configuredURL.protocol
  const hostname = configuredURL.hostname
  const fallbackHosts = [hostname]

  if (hostname === 'localhost') fallbackHosts.push('127.0.0.1')
  if (hostname === '127.0.0.1') fallbackHosts.push('localhost')

  const fallbacks = fallbackHosts.flatMap((host) =>
    Array.from({ length: 10 }, (_, offset) => `${protocol}//${host}:${8000 + offset}`),
  )

  return Array.from(
    new Set([configured, localStorage.getItem(API_BASE_STORAGE_KEY), ...fallbacks].filter(Boolean)),
  ) as string[]
}

export async function getApiBaseURL(): Promise<string> {
  const cached = localStorage.getItem(API_BASE_STORAGE_KEY)
  if (cached) {
    if (await isHealthy(cached, 700)) {
      return cached
    } else {
      localStorage.removeItem(API_BASE_STORAGE_KEY)
    }
  }

  for (const baseURL of candidateBaseURLs()) {
    if (await isHealthy(baseURL, 450)) {
      localStorage.setItem(API_BASE_STORAGE_KEY, baseURL)
      return baseURL
    }
  }

  return configuredBaseURL
}

async function isHealthy(baseURL: string, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseURL}/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const preferredBaseURL = await getApiBaseURL()
  const bases = Array.from(new Set([preferredBaseURL, ...candidateBaseURLs()]))
  let lastError: unknown

  for (const baseURL of bases) {
    try {
      const res = await fetch(`${baseURL}${path}`, {
        ...init,
        headers,
      })

      if (res.ok) {
        if (await isStaleStudioModuleResponse(path, res)) {
          lastError = new Error(`Studio module response did not match request on ${baseURL}`)
          continue
        }
        localStorage.setItem(API_BASE_STORAGE_KEY, baseURL)
        return res
      }

      if (res.status === 404) {
        lastError = new Error(`API route not found on ${baseURL}`)
        continue
      }

      throw new Error(`API request failed with status ${res.status}`)
    } catch (error) {
      lastError = error
    }
  }

  localStorage.removeItem(API_BASE_STORAGE_KEY)
  throw lastError instanceof Error ? lastError : new Error('API request failed')
}

async function isStaleStudioModuleResponse(path: string, res: Response) {
  const match = path.match(/^\/api\/studio\/modules\/([^/?]+)/)
  const rawModuleKey = match?.[1]
  if (!rawModuleKey) return false

  const expectedKey = expectedStudioModuleKey(decodeURIComponent(rawModuleKey))
  if (!expectedKey) return false

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return false

  const data = (await res.clone().json().catch(() => null)) as { key?: unknown } | null
  return typeof data?.key === 'string' && data.key !== expectedKey
}

function expectedStudioModuleKey(moduleKey: string) {
  const aliases: Record<string, string> = {
    traces: 'observability',
    network: 'agent-clusters',
    networks: 'agent-clusters',
    'agent-network': 'agent-clusters',
    'agent-networks': 'agent-clusters',
    cluster: 'agent-clusters',
    clusters: 'agent-clusters',
  }
  return aliases[moduleKey] ?? moduleKey
}
