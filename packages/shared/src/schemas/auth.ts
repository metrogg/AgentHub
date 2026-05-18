import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(128),
})
export type LoginInput = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(50),
  password: z.string().min(6).max(128),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  username: z.string(),
  avatarUrl: z.string().url().optional().nullable(),
  role: z.enum(['user', 'admin']).default('user'),
  createdAt: z.string(),
})
export type User = z.infer<typeof userSchema>

export const authResponseSchema = z.object({
  user: userSchema,
  token: z.string(),
})
export type AuthResponse = z.infer<typeof authResponseSchema>
