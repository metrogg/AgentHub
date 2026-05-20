import { create } from 'zustand'
import { authStorage, type AuthUser } from '../lib/auth'
import { api } from '../lib/api'

interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, username: string, password: string) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: authStorage.getUser(),
  isAuthenticated: !!authStorage.getToken(),
  loading: false,
  error: null,

  async login(email, password) {
    set({ loading: true, error: null })
    try {
      const { token, user } = await api.login({ email, password })
      authStorage.setToken(token)
      authStorage.setUser(user)
      set({ user, isAuthenticated: true, loading: false })
    } catch (e: any) {
      set({ error: e.message ?? '登录失败', loading: false })
      throw e
    }
  },

  async register(email, username, password) {
    set({ loading: true, error: null })
    try {
      const { token, user } = await api.register({ email, username, password })
      authStorage.setToken(token)
      authStorage.setUser(user)
      set({ user, isAuthenticated: true, loading: false })
    } catch (e: any) {
      set({ error: e.message ?? '注册失败', loading: false })
      throw e
    }
  },

  logout() {
    authStorage.clearAll()
    set({ user: null, isAuthenticated: false })
  },
}))
