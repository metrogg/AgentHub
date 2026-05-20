import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { loginSchema, registerSchema } from '@agenthub/shared'
import { db, users, eq } from '@agenthub/db'
import { hashPassword, signToken, verifyPassword } from '../lib/auth'

export const authRoutes = new Hono()
  .post('/register', zValidator('json', registerSchema), async (c) => {
    const { email, username, password } = c.req.valid('json')
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (existing.length > 0) {
      throw new HTTPException(409, { message: 'Email already registered' })
    }
    const passwordHash = await hashPassword(password)
    const [user] = await db
      .insert(users)
      .values({ email, username, passwordHash })
      .returning()
    if (!user) throw new HTTPException(500, { message: 'Failed to create user' })
    const token = await signToken({ sub: user.id, email: user.email })
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
      },
      token,
    })
  })
  .post('/login', zValidator('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json')
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HTTPException(401, { message: 'Invalid email or password' })
    }
    const token = await signToken({ sub: user.id, email: user.email })
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
      },
      token,
    })
  })
