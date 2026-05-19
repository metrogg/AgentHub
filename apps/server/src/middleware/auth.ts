import { createMiddleware } from 'hono/factory'
import { verifyToken, type JwtPayload } from '../lib/auth'

const ANONYMOUS_USER: JwtPayload = {
  sub: 'anonymous',
  email: 'anonymous@agenthub.local',
}

export type AuthVariables = {
  user: JwtPayload
}

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const payload = await verifyToken(token)
      c.set('user', payload)
      await next()
      return
    } catch {
      // fall through to anonymous
    }
  }
  c.set('user', ANONYMOUS_USER)
  await next()
})
