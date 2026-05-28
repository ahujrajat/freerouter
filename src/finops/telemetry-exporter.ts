import type { SpendRecord } from '../types.js'
import type { TelemetrySink } from './telemetry-sink.js'

export interface TelemetryExporterOptions {
  sink: TelemetrySink
  /**
   * Flush cadence in ms. Records buffered in-memory between flushes.
   * Set to 0 or omit to disable scheduled flushing (manual `flush()` only).
   */
  intervalMs?: number
  /**
   * Hard cap on the in-memory buffer. When exceeded, the oldest records are
   * dropped and `onDrop` is invoked. Default: 10_000.
   */
  maxBufferSize?: number
  /**
   * Called when the buffer overflows and records are dropped, and when a sink
   * append rejects. Receives the count and (optionally) the underlying error.
   * Default: writes a single warning line to stderr.
   */
  onDrop?: (count: number, reason: 'buffer-overflow' | 'sink-error', err?: unknown) => void
}

/**
 * Streams every completed-request `SpendRecord` to a `TelemetrySink`.
 *
 * Design notes:
 * - The exporter never reads from `SpendTracker`. The router calls `capture()`
 *   at the same site as `tracker.recordSpend()`, so pruning in the tracker is
 *   irrelevant to export completeness.
 * - Flushes serialize through a single in-flight promise — overlapping ticks
 *   coalesce instead of stacking writes.
 * - On `stop()`, a final flush is awaited so no buffered records are lost.
 */
export class TelemetryExporter {
  private readonly sink: TelemetrySink
  private readonly intervalMs: number
  private readonly maxBufferSize: number
  private readonly onDrop: NonNullable<TelemetryExporterOptions['onDrop']>

  private buffer: SpendRecord[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private flushing: Promise<void> | undefined
  private pendingFlush = false
  private stopped = false

  constructor(opts: TelemetryExporterOptions) {
    this.sink = opts.sink
    this.intervalMs = opts.intervalMs ?? 0
    this.maxBufferSize = opts.maxBufferSize ?? 10_000
    this.onDrop = opts.onDrop ?? ((count, reason, err) => {
      const detail = err !== undefined ? `: ${String(err)}` : ''
      process.stderr.write(`[FreeRouter] telemetry ${reason} dropped ${count} record(s)${detail}\n`)
    })
  }

  /** Begin periodic flushing. No-op if intervalMs is 0 or already started. */
  start(): void {
    if (this.timer !== undefined || this.intervalMs <= 0) return
    this.timer = setInterval(() => { void this.flush() }, this.intervalMs)
    this.timer.unref?.()
  }

  /**
   * Buffer a record for the next flush. Synchronous and allocation-light —
   * safe to call on the request hot path.
   */
  capture(record: SpendRecord): void {
    if (this.stopped) return
    if (this.buffer.length >= this.maxBufferSize) {
      const overflow = this.buffer.length - this.maxBufferSize + 1
      this.buffer.splice(0, overflow)
      this.onDrop(overflow, 'buffer-overflow')
    }
    this.buffer.push(record)
  }

  /**
   * Drain the buffer to the sink. Concurrent callers share the in-flight
   * promise; if a flush is already running, this returns once a follow-up
   * flush has captured any records added since.
   */
  async flush(): Promise<void> {
    if (this.flushing !== undefined) {
      this.pendingFlush = true
      await this.flushing
      if (this.pendingFlush && this.buffer.length > 0) {
        await this.flush()
      }
      return
    }

    if (this.buffer.length === 0) return

    const batch = this.buffer
    this.buffer = []
    this.pendingFlush = false

    this.flushing = this.sink.append(batch).catch(err => {
      // Best-effort recovery: put records back at the front of the buffer so
      // the next flush retries them. If that overflows, drop the oldest.
      this.buffer = [...batch, ...this.buffer]
      if (this.buffer.length > this.maxBufferSize) {
        const overflow = this.buffer.length - this.maxBufferSize
        this.buffer.splice(0, overflow)
        this.onDrop(overflow, 'sink-error', err)
      } else {
        this.onDrop(0, 'sink-error', err)
      }
    }).finally(() => {
      this.flushing = undefined
    })

    await this.flushing
  }

  /**
   * Stop scheduled flushing and drain the buffer one last time.
   * After `stop()`, `capture()` becomes a no-op.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.flush()
  }

  /** Test/inspection helper — current in-memory buffer size. */
  get bufferSize(): number {
    return this.buffer.length
  }
}
