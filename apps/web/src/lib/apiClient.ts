import { API_BASE_PATH, AppErrorCodes } from '@agenthub/shared'

export const API_BASE = API_BASE_PATH
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RETRIES = 2

export interface RequestOptions extends RequestInit {
  timeout?: number
}

export class ApiError extends Error {
  public code?: string
  public requestId?: string

  constructor(
    public status: number,
    message: string,
    code?: string,
    requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.requestId = requestId
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('abort') ||
    msg.includes('timeout')
  )
}

export function friendlyErrorMessage(error: unknown, context?: string): string {
  const prefix = context ? `${context}：` : ''
  if (error instanceof ApiError) {
    // 根据错误码提供比 HTTP 状态码更精准的中文提示
    const codeMap: Record<string, string> = {
      [AppErrorCodes.INTERNAL_ERROR]: '服务端内部错误，请稍后重试',
      [AppErrorCodes.SERVICE_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
      [AppErrorCodes.TIMEOUT]: '请求超时，请稍后重试',
      [AppErrorCodes.VALIDATION_FAILED]: '请求参数错误',
      [AppErrorCodes.MISSING_FIELD]: '缺少必要参数',
      [AppErrorCodes.UNAUTHORIZED]: '未登录或登录已过期',
      [AppErrorCodes.FORBIDDEN]: '没有权限执行此操作',
      [AppErrorCodes.SESSION_NOT_FOUND]: '会话不存在或已被删除',
      [AppErrorCodes.MESSAGE_NOT_FOUND]: '消息不存在或已被删除',
      [AppErrorCodes.WORKSPACE_NOT_FOUND]: '工作区不存在或已被删除',
      [AppErrorCodes.TASK_NOT_FOUND]: '任务不存在或已被删除',
      [AppErrorCodes.AGENT_NOT_FOUND]: 'Agent 不存在或已被删除',
      [AppErrorCodes.FILE_NOT_FOUND]: '文件不存在',
      [AppErrorCodes.ARTIFACT_NOT_FOUND]: '产物不存在',
      [AppErrorCodes.LLM_REQUEST_FAILED]: 'AI 服务请求失败，请检查模型配置',
      [AppErrorCodes.LLM_RATE_LIMITED]: 'AI 服务请求过于频繁，请稍后重试',
      [AppErrorCodes.MODEL_NOT_CONFIGURED]: '模型未配置，请先完成设置',
      [AppErrorCodes.CODE_AGENT_NOT_INSTALLED]: '代码 Agent 未安装，请先安装 CLI 工具',
      [AppErrorCodes.CODE_AGENT_CONFIG_INVALID]: '代码 Agent 配置错误',
      [AppErrorCodes.ORCHESTRATOR_PLAN_FAILED]: '编排计划生成失败，请稍后重试',
      [AppErrorCodes.ORCHESTRATOR_DISPATCH_FAILED]: '任务派发失败，请稍后重试',
      [AppErrorCodes.DIFF_APPLY_FAILED]: '代码补丁应用失败',
      [AppErrorCodes.DIFF_VALIDATION_FAILED]: '代码补丁校验失败',
    }
    if (error.code && codeMap[error.code]) {
      if (
        error.code === AppErrorCodes.DIFF_APPLY_FAILED ||
        error.code === AppErrorCodes.DIFF_VALIDATION_FAILED
      ) {
        return prefix + normalizeErrorMessage(error.message, codeMap[error.code])
      }
      return prefix + codeMap[error.code]
    }
    if (error.status === 500 && error.message === 'Internal Server Error') {
      return prefix + '服务端暂不可用，请确认后端服务已启动后重试'
    }
    return prefix + normalizeErrorMessage(error.message, `HTTP ${error.status}`)
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('failed to fetch')) {
      return prefix + '网络连接中断，请确认服务端已启动后重试'
    }
    if (msg.includes('abort')) {
      return prefix + '请求超时，请稍后重试'
    }
    return prefix + normalizeErrorMessage(error.message)
  }
  return prefix + normalizeUnknownError(error)
}

async function requestWithRetry<T>(path: string, init?: RequestOptions, attempt = 0): Promise<T> {
  const timeoutMs = init?.timeout ?? DEFAULT_TIMEOUT_MS
  const method = (init?.method ?? 'GET').toUpperCase()
  const canRetry = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Merge caller's signal with our timeout controller
  const callerSignal = init?.signal
  const onCallerAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason)
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      const errorPayload = body?.error ?? {}
      const message = extractApiErrorMessage(body, res.status)
      const code = typeof errorPayload === 'object' ? errorPayload.code : undefined
      const requestId = typeof errorPayload === 'object' ? errorPayload.requestId : undefined
      throw new ApiError(res.status, message, code, requestId)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (error) {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)

    // Don't retry if the caller explicitly aborted (e.g. component unmount or user cancel)
    if (callerSignal?.aborted) {
      throw error
    }

    // Server errors (5xx) and network errors are retryable
    const shouldRetry =
      attempt < MAX_RETRIES &&
      canRetry &&
      (isRetryableError(error) || (error instanceof ApiError && error.status >= 500))

    if (shouldRetry) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      return requestWithRetry<T>(path, init, attempt + 1)
    }

    throw error
  }
}

export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  return requestWithRetry<T>(path, init)
}

function extractApiErrorMessage(body: any, status: number): string {
  const candidates = [
    body?.error?.message,
    body?.error,
    body?.message,
    body?.details,
    body,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeUnknownError(candidate)
    if (normalized && normalized !== '请求失败' && normalized !== '[object Object]') return normalized
  }
  return `HTTP ${status}`
}

function normalizeErrorMessage(message: string, fallback = '请求失败'): string {
  const trimmed = message.trim()
  if (!trimmed || trimmed === '[object Object]') return fallback
  return trimmed
}

function normalizeUnknownError(error: unknown): string {
  if (typeof error === 'string') return normalizeErrorMessage(error)
  if (error instanceof Error) return normalizeErrorMessage(error.message)
  if (!error || typeof error !== 'object') return '请求失败'

  const record = error as Record<string, unknown>
  const nestedCandidates = [record.message, record.error, record.details, record.reason]
  for (const candidate of nestedCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      const nested = normalizeUnknownError(candidate)
      if (nested && nested !== '请求失败') return nested
    }
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized && serialized !== '{}' ? serialized : '请求失败'
  } catch {
    return '请求失败'
  }
}
