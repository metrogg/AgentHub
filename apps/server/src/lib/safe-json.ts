import { logger } from './logger'

/**
 * 安全 JSON 解析：解析失败时返回 fallback 而非抛异常。
 * 用于所有从 DB TEXT/JSON 字段、外部 CLI stdout、设置值等读取 JSON 的场景，
 * 防止脏数据导致请求崩溃。
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

/**
 * 安全 JSON 解析（返回 null 表示失败）。
 * 适用于调用方需要区分"解析成功但值为 fallback"和"解析失败"的场景。
 */
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
