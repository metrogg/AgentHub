import { logger } from './logger'

/**
 * Parse JSON without letting dirty DB/settings/external payloads crash a request.
 */
export function safeJsonParse<T>(text: string, fallback: T, context?: string): T {
  try {
    return JSON.parse(text) as T
  } catch (err: any) {
    logger.warn(
      { err: err?.message, context, snippet: text.slice(0, 120) },
      'safeJsonParse failed, returning fallback',
    )
    return fallback
  }
}

export function tryJsonParse<T>(text: string, context?: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch (err: any) {
    logger.warn(
      { err: err?.message, context, snippet: text.slice(0, 120) },
      'tryJsonParse failed, returning null',
    )
    return null
  }
}
