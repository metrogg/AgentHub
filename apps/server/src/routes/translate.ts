import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { streamReply } from '../services/llm'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

const translateSchema = z.object({
  text: z.string().min(1),
  targetLang: z.enum(['zh', 'en']).default('zh'),
})

export const translateRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .post('/', zValidator('json', translateSchema), async (c) => {
    const { text, targetLang } = c.req.valid('json')
    const langName = targetLang === 'zh' ? '中文' : 'English'

    const system = `You are a professional translator. Translate the following text to ${langName}. Keep markdown formatting, code blocks, and structure. Output only the translation.`

    return streamSSE(c, async (stream) => {
      try {
        for await (const delta of streamReply([{ role: 'user', content: text }], system)) {
          await stream.writeSSE({ data: delta, event: 'chunk' })
        }
      } catch {
        // LLM errors silently absorbed
      }
      await stream.writeSSE({ data: '', event: 'done' })
    })
  })
