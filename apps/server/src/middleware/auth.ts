import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verifyToken, type JwtPayload } from '../lib/auth'

export type AuthVariables = {
  user: JwtPayload
}

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' })
  }
  const token = authHeader.slice(7)
  try {
    const payload = await verifyToken(token)
    c.set('user', payload)
  } catch {
    throw new HTTPException(401, { message: 'Invalid or expired token' })
  }
  await next()
})
