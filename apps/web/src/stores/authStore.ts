import { create } from 'zustand'

interface User {
  id: string
  email: string
  username: string
  avatar_url?: string
}

interface AuthState {
  user: User
  token: string
  isAuthenticated: boolean
}

const ANONYMOUS_USER: User = {
  id: 'anonymous',
  email: 'anonymous@agenthub.local',
  username: '匿名用户',
}

localStorage.setItem('token', 'anonymous-token')

export const useAuthStore = create<AuthState>(() => ({
  user: ANONYMOUS_USER,
  token: 'anonymous-token',
  isAuthenticated: true,
}))
