import { hc } from 'hono/client'
import type { AppType } from '@agenthub/server'

const baseURL = import.meta.env.VITE_API_URL ?? '/api'

export const api = hc<AppType>(baseURL, {
  headers: (): Record<string, string> => {
    const token = localStorage.getItem('token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  },
})

export type Api = typeof api
