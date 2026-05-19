import { db, settings, eq } from '@agenthub/db'
import { env } from '../env'
import { logger } from '../lib/logger'
import { createAssistantAgent, DEFAULT_AGENT_INSTRUCTIONS } from '../mastra/agents'

async function getApiKey(): Promise<string | null> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'ANTHROPIC_API_KEY')).limit(1)
    if (row?.value) return row.value
  } catch {
    // Settings are optional; fall back to environment configuration.
  }

  return env.ANTHROPIC_API_KEY ?? null
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
    const agent = createAssistantAgent(apiKey, system ?? DEFAULT_AGENT_INSTRUCTIONS)
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
