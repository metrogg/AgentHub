/**
 * AgentHub 统一错误码与错误响应规范
 *
 * 设计目标：
 * 1. 每个 API 错误都有机器可识别的错误码（code），方便前端分类处理
 * 2. 错误响应包含 requestId，便于全链路追踪
 * 3. 保留 HTTP 状态码语义，同时补充业务错误分类
 * 4. 错误消息面向用户可读，日志中的详情面向开发者调试
 *
 * 使用方式：
 * ```ts
 * throw AppError.notFound('SESSION_NOT_FOUND', '会话不存在')
 * throw AppError.badRequest('VALIDATION_FAILED', '参数错误', { field: 'title' })
 * throw AppError.internal('LLM_REQUEST_FAILED', 'LLM 请求失败', { provider: 'openai' })
 * ```
 */

import { HTTPException } from 'hono/http-exception'
import { AppErrorCodes, type AppErrorCode } from '@agenthub/shared'

export { AppErrorCodes, type AppErrorCode }

// ------------------------------------------------------------------
// 错误码 → HTTP 状态码映射
// ------------------------------------------------------------------

const codeToHttpStatus: Record<AppErrorCode, number> = {
  [AppErrorCodes.INTERNAL_ERROR]: 500,
  [AppErrorCodes.NOT_IMPLEMENTED]: 501,
  [AppErrorCodes.SERVICE_UNAVAILABLE]: 503,
  [AppErrorCodes.TIMEOUT]: 504,

  [AppErrorCodes.VALIDATION_FAILED]: 400,
  [AppErrorCodes.INVALID_JSON]: 400,
  [AppErrorCodes.MISSING_FIELD]: 400,
  [AppErrorCodes.INVALID_UUID]: 400,

  [AppErrorCodes.UNAUTHORIZED]: 401,
  [AppErrorCodes.FORBIDDEN]: 403,

  [AppErrorCodes.SESSION_NOT_FOUND]: 404,
  [AppErrorCodes.SESSION_CREATE_FAILED]: 500,
  [AppErrorCodes.SESSION_DELETE_FAILED]: 500,

  [AppErrorCodes.MESSAGE_NOT_FOUND]: 404,
  [AppErrorCodes.MESSAGE_UPDATE_FAILED]: 500,
  [AppErrorCodes.MESSAGE_PIN_FAILED]: 500,
  [AppErrorCodes.ORCHESTRATOR_PLAN_FAILED]: 500,
  [AppErrorCodes.ORCHESTRATOR_DISPATCH_FAILED]: 500,

  [AppErrorCodes.WORKSPACE_NOT_FOUND]: 404,
  [AppErrorCodes.WORKSPACE_CREATE_FAILED]: 500,
  [AppErrorCodes.WORKSPACE_UPDATE_FAILED]: 500,
  [AppErrorCodes.PROJECT_PATH_INVALID]: 400,
  [AppErrorCodes.PROJECT_PATH_NOT_FOUND]: 400,

  [AppErrorCodes.TASK_NOT_FOUND]: 404,
  [AppErrorCodes.TASK_EXECUTION_FAILED]: 500,
  [AppErrorCodes.TASK_MAX_RETRIES_EXCEEDED]: 500,
  [AppErrorCodes.TASK_CANCEL_FAILED]: 500,

  [AppErrorCodes.AGENT_NOT_FOUND]: 404,
  [AppErrorCodes.AGENT_REPLY_FAILED]: 500,
  [AppErrorCodes.CODE_AGENT_NOT_INSTALLED]: 400,
  [AppErrorCodes.CODE_AGENT_CONFIG_INVALID]: 400,
  [AppErrorCodes.CODE_AGENT_EXECUTION_FAILED]: 500,

  [AppErrorCodes.LLM_REQUEST_FAILED]: 502,
  [AppErrorCodes.LLM_RATE_LIMITED]: 429,
  [AppErrorCodes.LLM_INVALID_RESPONSE]: 502,
  [AppErrorCodes.MODEL_NOT_CONFIGURED]: 400,

  [AppErrorCodes.ORCHESTRATOR_RUN_NOT_FOUND]: 404,
  [AppErrorCodes.ORCHESTRATOR_RUN_FAILED]: 500,
  [AppErrorCodes.ORCHESTRATOR_PLAN_INVALID]: 400,
  [AppErrorCodes.ORCHESTRATOR_SYNTHESIZE_FAILED]: 500,

  [AppErrorCodes.FILE_NOT_FOUND]: 404,
  [AppErrorCodes.FILE_ACCESS_DENIED]: 403,
  [AppErrorCodes.ARTIFACT_NOT_FOUND]: 404,
  [AppErrorCodes.DIFF_APPLY_FAILED]: 500,
  [AppErrorCodes.DIFF_VALIDATION_FAILED]: 400,

  [AppErrorCodes.SETTINGS_SAVE_FAILED]: 500,
  [AppErrorCodes.CODING_TOOL_NOT_FOUND]: 404,
  [AppErrorCodes.CODING_TOOL_INSTALL_FAILED]: 500,
}

// ------------------------------------------------------------------
// AppError 类
// ------------------------------------------------------------------

export interface AppErrorDetails {
  [key: string]: unknown
}

export class AppError extends HTTPException {
  public readonly code: AppErrorCode
  public readonly details?: AppErrorDetails
  public readonly requestId?: string

  constructor(
    status: number,
    code: AppErrorCode,
    message: string,
    details?: AppErrorDetails,
    requestId?: string,
  ) {
    super(status as any, { message })
    this.code = code
    this.details = details
    this.requestId = requestId
    // 修复原型链（TypeScript 继承内置类）
    Object.setPrototypeOf(this, AppError.prototype)
  }

  // ---- 工厂方法 ----

  static badRequest(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(400, code, message, details, requestId)
  }

  static unauthorized(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(401, code, message, details, requestId)
  }

  static forbidden(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(403, code, message, details, requestId)
  }

  static notFound(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(404, code, message, details, requestId)
  }

  static conflict(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(409, code, message, details, requestId)
  }

  static tooManyRequests(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(429, code, message, details, requestId)
  }

  static internal(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(500, code, message, details, requestId)
  }

  static badGateway(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(502, code, message, details, requestId)
  }

  static serviceUnavailable(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(503, code, message, details, requestId)
  }

  static gatewayTimeout(code: AppErrorCode, message: string, details?: AppErrorDetails, requestId?: string) {
    return new AppError(504, code, message, details, requestId)
  }

  static fromCode(
    code: AppErrorCode,
    message: string,
    details?: AppErrorDetails,
    requestId?: string,
  ): AppError {
    const status = codeToHttpStatus[code] ?? 500
    return new AppError(status, code, message, details, requestId)
  }

  // 将普通 Error / HTTPException 包装为 AppError
  static wrap(
    err: unknown,
    fallbackCode: AppErrorCode = AppErrorCodes.INTERNAL_ERROR,
    fallbackMessage = '服务器内部错误',
    requestId?: string,
  ): AppError {
    if (err instanceof AppError) return err
    if (err instanceof HTTPException) {
      const code = (err.status >= 500 ? AppErrorCodes.INTERNAL_ERROR :
                    err.status === 404 ? AppErrorCodes.SESSION_NOT_FOUND :
                    err.status === 403 ? AppErrorCodes.FORBIDDEN :
                    err.status === 401 ? AppErrorCodes.UNAUTHORIZED :
                    AppErrorCodes.VALIDATION_FAILED) as AppErrorCode
      return new AppError(err.status, code, err.message, undefined, requestId)
    }
    const message = err instanceof Error ? err.message : String(err)
    return new AppError(500, fallbackCode, fallbackMessage, { originalError: message }, requestId)
  }
}

// ------------------------------------------------------------------
// 响应格式化
// ------------------------------------------------------------------

export interface ErrorResponseBody {
  success: false
  error: {
    code: AppErrorCode
    message: string
    details?: AppErrorDetails
    requestId?: string
  }
}

export function formatErrorResponse(
  err: unknown,
  requestId?: string,
  isDev = false,
): { body: ErrorResponseBody; status: number } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          requestId: err.requestId ?? requestId,
        },
      },
    }
  }

  if (err instanceof HTTPException) {
    return {
      status: err.status,
      body: {
        success: false,
        error: {
          code: AppErrorCodes.INTERNAL_ERROR,
          message: err.message,
          requestId,
        },
      },
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  const stack = isDev && err instanceof Error ? err.stack : undefined

  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: AppErrorCodes.INTERNAL_ERROR,
        message: isDev ? message : 'Internal Server Error',
        details: stack ? { stack } : undefined,
        requestId,
      },
    },
  }
}
