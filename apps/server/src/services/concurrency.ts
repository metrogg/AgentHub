import { logger } from '../lib/logger'

// ─── Semaphore ───────────────────────────────

export class Semaphore {
  private permits: number
  private queue: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void }> = []

  constructor(initialPermits: number) {
    this.permits = Math.max(0, initialPermits)
  }

  async acquire(timeoutMs = 30000): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--
      return () => this.release()
    }

    return new Promise((resolve, reject) => {
      const item = { resolve, reject }
      this.queue.push(item)

      if (timeoutMs > 0) {
        setTimeout(() => {
          const idx = this.queue.indexOf(item)
          if (idx >= 0) {
            this.queue.splice(idx, 1)
            reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms`))
          }
        }, timeoutMs)
      }
    })
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next.resolve(() => this.release())
    } else {
      this.permits++
    }
  }
}

// ─── Token Bucket ───────────────────────────────

export interface TokenBucketConfig {
  rate: number // 每秒补充的 token 数
  capacity: number // 桶容量
}

export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(private config: TokenBucketConfig) {
    this.tokens = config.capacity
    this.lastRefill = Date.now()
  }

  async consume(amount = 1): Promise<void> {
    while (true) {
      const now = Date.now()
      const elapsed = (now - this.lastRefill) / 1000
      this.tokens = Math.min(this.config.capacity, this.tokens + elapsed * this.config.rate)
      this.lastRefill = now

      if (this.tokens >= amount) {
        this.tokens -= amount
        return
      }

      const waitTime = ((amount - this.tokens) / this.config.rate) * 1000
      await new Promise((r) => setTimeout(r, Math.min(waitTime, 5000)))
    }
  }
}

// ─── Circuit Breaker ───────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerConfig {
  failureThreshold: number // 触发熔断的失败次数
  timeout: number // 熔断持续时间（ms）
  halfOpenMaxCalls: number // 半开状态允许的测试调用数
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private successCount = 0
  private lastFailureTime?: number

  constructor(private config: CircuitBreakerConfig) {}

  getState(): CircuitState {
    return this.state
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - (this.lastFailureTime || 0) > this.config.timeout) {
        this.state = 'half-open'
        this.failureCount = 0
        this.successCount = 0
        logger.info('Circuit breaker entering half-open state')
      } else {
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++
      if (this.successCount >= this.config.halfOpenMaxCalls) {
        this.state = 'closed'
        this.failureCount = 0
        this.successCount = 0
        logger.info('Circuit breaker closed')
      }
    } else {
      this.failureCount = 0
    }
  }

  private onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === 'half-open') {
      this.state = 'open'
      logger.warn('Circuit breaker opened (half-open failure)')
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open'
      logger.warn({ failureCount: this.failureCount }, 'Circuit breaker opened')
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitBreakerOpenError'
  }
}

// ─── ConcurrencyController ───────────────────────────────

export interface ConcurrencyConfig {
  maxConcurrentAgents: number
  providerLimits: Record<string, { requestsPerSecond: number; burstCapacity: number }>
}

export class ConcurrencyController {
  private agentSemaphore: Semaphore
  private tokenBuckets = new Map<string, TokenBucket>()

  constructor(config: ConcurrencyConfig) {
    this.agentSemaphore = new Semaphore(config.maxConcurrentAgents)

    for (const [provider, limits] of Object.entries(config.providerLimits)) {
      this.tokenBuckets.set(provider, new TokenBucket({ rate: limits.requestsPerSecond, capacity: limits.burstCapacity }))
    }
  }

  async acquire(provider?: string, timeoutMs = 30000): Promise<() => void> {
    // 1. 等待信号量
    const releaseSemaphore = await this.agentSemaphore.acquire(timeoutMs)

    // 2. 等待 Token Bucket（如果指定了 provider）
    let releaseToken: (() => void) | undefined
    if (provider) {
      const bucket = this.tokenBuckets.get(provider)
      if (bucket) {
        await bucket.consume(1)
      }
    }

    // 3. 返回释放函数
    return () => {
      releaseSemaphore()
      if (releaseToken) releaseToken()
    }
  }
}
