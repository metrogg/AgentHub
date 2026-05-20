import { db, settings, eq } from '@agenthub/db'
import { env } from '../env'
import { logger } from '../lib/logger'
import { createAssistantAgent, DEFAULT_AGENT_INSTRUCTIONS } from '../mastra/agents'

async function getApiKey(): Promise<string | null> {
  try {
    const [activeKey] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'ACTIVE_API_KEY'))
      .limit(1)
    if (activeKey?.value) return activeKey.value

    const [row] = await db.select().from(settings).where(eq(settings.key, 'ANTHROPIC_API_KEY')).limit(1)
    if (row?.value) return row.value
  } catch {
    // Settings are optional; fall back to environment configuration.
  }

  return env.ANTHROPIC_API_KEY ?? null
}

async function getModel(): Promise<string> {
  try {
    const [activeModel] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'ACTIVE_MODEL'))
      .limit(1)
    if (activeModel?.value) return activeModel.value

    const [row] = await db.select().from(settings).where(eq(settings.key, 'ANTHROPIC_MODEL')).limit(1)
    if (row?.value) return row.value
  } catch {
    // Settings are optional; fall back to environment configuration.
  }

  return env.ANTHROPIC_MODEL
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function* streamReply(
  messages: LLMMessage[],
  system?: string
): AsyncGenerator<string, void, unknown> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    yield 'ANTHROPIC_API_KEY is not configured. Add it in Settings or set it in .env and restart the server.'
    return
  }

  try {
    const model = await getModel()
    const agent = createAssistantAgent(apiKey, system ?? DEFAULT_AGENT_INSTRUCTIONS, model)
    const stream = await agent.stream(
      messages.map((m) => ({ role: m.role, content: m.content }))
    )

    for await (const delta of stream.textStream) {
      yield delta
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Mastra LLM stream error')
    yield `\n\n[Error: ${err.message || 'LLM call failed'}]`
  }
}
