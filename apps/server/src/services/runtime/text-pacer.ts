export class TextPacer {
  private buffer = ''
  private committed = ''
  private lastDrainPos = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly intervalMs: number
  private readonly takeRate: (bufferLen: number) => number

  constructor(
    intervalMs = 33,
    takeRate: (bufferLen: number) => number = (len) => Math.max(1, Math.ceil(len / 6)),
  ) {
    this.intervalMs = intervalMs
    this.takeRate = takeRate
  }

  push(delta: string): void {
    this.buffer += delta
    this.ensureTimer()
  }

  /** 取出上次 drain 后新提交的文本（由 pacer tick 产出） */
  drain(): string {
    const delta = this.committed.slice(this.lastDrainPos)
    this.lastDrainPos = this.committed.length
    return delta
  }

  finishImmediate(): string {
    this.committed += this.buffer
    this.buffer = ''
    this.stopTimer()
    const delta = this.committed.slice(this.lastDrainPos)
    this.lastDrainPos = this.committed.length
    return delta
  }

  reset(): void {
    this.stopTimer()
    this.buffer = ''
    this.committed = ''
    this.lastDrainPos = 0
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    if (!this.buffer) {
      this.stopTimer()
      return
    }
    const take = this.takeRate(this.buffer.length)
    this.committed += this.buffer.slice(0, take)
    this.buffer = this.buffer.slice(take)
  }
}
