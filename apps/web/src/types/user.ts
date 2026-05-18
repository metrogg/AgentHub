export interface User {
  id: string
  email: string
  username: string
  avatar_url?: string
  role: 'admin' | 'user'
  created_at: string
  updated_at: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  username: string
  password: string
}
