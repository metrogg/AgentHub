import { logger } from '../../lib/logger'
import {
  resourceKey,
  type ControllerResourceKind,
  type ReconcileRequest,
  type ReconcileResult,
} from './resource-types'

export type ReconcileHandler<K extends ControllerResourceKind = ControllerResourceKind> = (
  request: ReconcileRequest<K>,
) => Promise<ReconcileResult>

export interface ReconcileQueueOptions {
  maxBatchSize?: number
  onResult?: (result: ReconcileResult) => void | Promise<void>
  onError?: (request: ReconcileRequest, error: unknown) => void | Promise<void>
}

interface QueuedRequest {
  request: ReconcileRequest
  availableAt: number
}

export class ReconcileQueue {
  private readonly handlers = new Map<ControllerResourceKind, ReconcileHandler>()
  private readonly queue = new Map<string, QueuedRequest>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private readonly options: ReconcileQueueOptions = {}) {}

  register<K extends ControllerResourceKind>(
    kind: K,
    handler: ReconcileHandler<K>,
  ): void {
    this.handlers.set(kind, handler as ReconcileHandler)
  }

  enqueue(
    request: Omit<ReconcileRequest, 'requestedAt'> & { requestedAt?: string },
    input: { delayMs?: number } = {},
  ): ReconcileRequest {
    const normalized: ReconcileRequest = {
      ...request,
      requestedAt: request.requestedAt ?? new Date().toISOString(),
    }
    const key = resourceKey(normalized.ref)
    const existing = this.queue.get(key)
    const availableAt = Date.now() + Math.max(0, input.delayMs ?? 0)
    this.queue.set(key, {
      request: {
        ...normalized,
        reason: existing
          ? `${existing.request.reason},${normalized.reason}`
          : normalized.reason,
      },
      availableAt: existing ? Math.min(existing.availableAt, availableAt) : availableAt,
    })
    this.schedule()
    return normalized
  }

  size(): number {
    return this.queue.size
  }

  pendingKeys(): string[] {
    return [...this.queue.keys()]
  }

  describe() {
    return {
      running: this.running,
      size: this.queue.size,
      pendingKeys: this.pendingKeys(),
      registeredKinds: [...this.handlers.keys()],
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async drainOnce(now = Date.now()): Promise<ReconcileResult[]> {
    const batch = this.takeReadyBatch(now)
    const results: ReconcileResult[] = []
    for (const item of batch) {
      const handler = this.handlers.get(item.request.ref.kind)
      if (!handler) {
        const result: ReconcileResult = {
          ref: item.request.ref,
          phase: 'missing-handler',
          changed: false,
          error: `No reconcile handler registered for ${item.request.ref.kind}.`,
        }
        results.push(result)
        await this.options.onResult?.(result)
        continue
      }

      try {
        const result = await handler(item.request)
        results.push(result)
        await this.options.onResult?.(result)
        if (result.requeueAfterMs !== undefined && result.requeueAfterMs > 0) {
          this.enqueue(
            {
              ref: result.ref,
              reason: `requeue:${result.phase}`,
              payload: item.request.payload,
            },
            { delayMs: result.requeueAfterMs },
          )
        }
      } catch (error) {
        logger.warn(
          { err: error, ref: item.request.ref, reason: item.request.reason },
          'Controller reconcile failed',
        )
        await this.options.onError?.(item.request, error)
        results.push({
          ref: item.request.ref,
          phase: 'exception',
          changed: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.schedule()
    return results
  }

  private takeReadyBatch(now: number): QueuedRequest[] {
    const maxBatchSize = this.options.maxBatchSize ?? 25
    const ready: Array<[string, QueuedRequest]> = []
    for (const entry of this.queue) {
      if (entry[1].availableAt <= now) ready.push(entry)
      if (ready.length >= maxBatchSize) break
    }
    for (const [key] of ready) {
      this.queue.delete(key)
    }
    return ready.map(([, request]) => request)
  }

  private schedule(): void {
    if (!this.running || this.timer || this.queue.size === 0) return
    const nextAt = Math.min(...[...this.queue.values()].map((item) => item.availableAt))
    const delayMs = Math.max(0, nextAt - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drainOnce()
    }, delayMs)
  }
}
