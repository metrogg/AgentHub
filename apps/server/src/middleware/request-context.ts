/**
 * 请求上下文中间件
 *
 * 为每个 HTTP 请求生成唯一的 requestId，并：
 * 1. 设置响应头 X-Request-Id
 * 2. 将 requestId 注入 Hono context，供后续路由使用
 * 3. 创建绑定 requestId 的 child logger，统一追踪日志
 */

import type { MiddlewareHandler } from 'hono'
import { logger as rootLogger } from '../lib/logger'

// Hono context 变量类型扩展（在 app.ts 中通过 .get/set 使用）
export interface RequestContext {
  requestId: string
  logger: typeof rootLogger
}

declare module 'hono' {
  interface ContextVariableMap {
    requestContext: RequestContext
  }
}

export const requestContextMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header('X-Request-Id') ?? crypto.randomUUID()
  const childLogger = rootLogger.child({ requestId })
  c.set('requestContext', {
    requestId,
    logger: childLogger,
  })
  c.header('X-Request-Id', requestId)
  const start = performance.now()
  childLogger.info({ method: c.req.method, path: c.req.path, query: c.req.query() }, 'Request started')
  try {
    await next()
  } finally {
    const duration = Math.round(performance.now() - start)
    childLogger.info({ method: c.req.method, path: c.req.path, status: c.res.status, durationMs: duration }, 'Request completed')
  }
}

// 便捷获取函数（路由中使用）
export function getRequestContext(c: { get: <K extends keyof import('hono').ContextVariableMap>(key: K) => import('hono').ContextVariableMap[K] }): RequestContext {
  return c.get('requestContext')
}
