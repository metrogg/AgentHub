import { createMiddleware } from 'hono/factory'

export const DEFAULT_USER = {
  sub: 'default-user',
  email: 'local@agenthub.local',
  username: 'You',
} as const

export type CurrentUser = typeof DEFAULT_USER

export type AuthVariables = {
  user: CurrentUser
}

/**
 * Single-user mode: no authentication. Always injects the local default user.
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  c.set('user', DEFAULT_USER)
  await next()
})
