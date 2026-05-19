import { create } from 'zustand'
import { api } from '../api/client'

export interface Session {
  id: string
  title: string
  type: 'direct' | 'group'
  ownerId: string
  createdAt: string
  updatedAt: string
}

interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  isLoading: boolean
  error: string | null
  fetchSessions: () => Promise<void>
  createSession: (title: string) => Promise<Session | null>
  setCurrentSession: (id: string | null) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  currentSessionId: null,
  isLoading: false,
  error: null,

  async fetchSessions() {
    set({ isLoading: true, error: null })
    try {
      const res = await api.api.sessions.$get()
      const data = await res.json()
      set({ sessions: (data as any).items ?? [], isLoading: false })
    } catch (e: any) {
      set({ error: e.message, isLoading: false })
    }
  },

  async createSession(title: string) {
    try {
      const res = await api.api.sessions.$post({
        json: { title, type: 'direct', agentIds: [] },
      })
      const session = await res.json()
      set((state) => ({
        sessions: [session as Session, ...state.sessions],
        currentSessionId: (session as Session).id,
      }))
      return session as Session
    } catch (e: any) {
      set({ error: e.message })
      return null
    }
  },

  setCurrentSession(id) {
    set({ currentSessionId: id })
  },
}))
