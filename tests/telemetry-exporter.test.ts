import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TelemetryExporter } from '../src/finops/telemetry-exporter.js'
import { MemoryTelemetrySink, NullTelemetrySink } from '../src/finops/telemetry-sink.js'
import { FileTelemetrySink } from '../src/adapters/file-telemetry-sink.js'
import type { TelemetrySink } from '../src/finops/telemetry-sink.js'
import type { SpendRecord } from '../src/types.js'

const makeRecord = (i: number): SpendRecord => ({
  userId: `u${i}`,
  provider: 'openai',
  model: 'gpt-4o-mini',
  tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  costUsd: 0.001 * i,
  timestamp: 1_700_000_000_000 + i,
})

// ── TelemetryExporter ───────────────────────────────────────────────────────

describe('TelemetryExporter', () => {
  it('buffers records and flushes them to the sink', async () => {
    const sink = new MemoryTelemetrySink()
    const exp = new TelemetryExporter({ sink })

    exp.capture(makeRecord(1))
    exp.capture(makeRecord(2))
    expect(sink.appended).toHaveLength(0)
    expect(exp.bufferSize).toBe(2)

    await exp.flush()
    expect(sink.appended).toHaveLength(2)
    expect(exp.bufferSize).toBe(0)
  })

  it('flush() is a no-op when buffer is empty', async () => {
    const sink = new MemoryTelemetrySink()
    const exp = new TelemetryExporter({ sink })
    await exp.flush()
    expect(sink.appended).toHaveLength(0)
  })

  it('start() schedules periodic flushes that drain the buffer', async () => {
    vi.useFakeTimers()
    try {
      const sink = new MemoryTelemetrySink()
      const exp = new TelemetryExporter({ sink, intervalMs: 100 })
      exp.start()

      exp.capture(makeRecord(1))
      await vi.advanceTimersByTimeAsync(150)
      // setInterval fired once → flush kicked off
      // Await microtasks so the in-flight flush promise resolves
      await vi.runOnlyPendingTimersAsync()
      await exp.flush()
      expect(sink.appended.length).toBeGreaterThanOrEqual(1)

      await exp.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() with intervalMs=0 is a no-op', async () => {
    const sink = new MemoryTelemetrySink()
    const exp = new TelemetryExporter({ sink, intervalMs: 0 })
    exp.start()
    exp.capture(makeRecord(1))
    // No timer fired; buffer still holds the record
    expect(exp.bufferSize).toBe(1)
    await exp.flush()
    expect(sink.appended).toHaveLength(1)
  })

  it('concurrent flush() calls coalesce — second flush picks up records added mid-flight', async () => {
    const resolvers: Array<() => void> = []
    const sink: TelemetrySink = {
      append: vi.fn(async () => {
        await new Promise<void>(r => { resolvers.push(r) })
      }),
    }
    const exp = new TelemetryExporter({ sink })
    exp.capture(makeRecord(1))

    const p1 = exp.flush()
    // Yield so the first append begins
    await Promise.resolve()
    exp.capture(makeRecord(2))   // arrives mid-flight
    const p2 = exp.flush()       // coalesces with p1, then triggers follow-up flush

    // Resolve appends as they queue up. We expect two: the original and the
    // follow-up that drains record 2.
    const drain = async () => {
      while (resolvers.length === 0) await Promise.resolve()
      resolvers.shift()!()
    }
    await drain()                  // resolves the first append
    await drain()                  // resolves the follow-up
    await Promise.all([p1, p2])

    const calls = (sink.append as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBe(2)
    expect((calls[0]![0] as SpendRecord[])[0]!.userId).toBe('u1')
    expect((calls[1]![0] as SpendRecord[])[0]!.userId).toBe('u2')
  })

  it('stop() flushes the buffer and disables further capture', async () => {
    const sink = new MemoryTelemetrySink()
    const exp = new TelemetryExporter({ sink, intervalMs: 1000 })
    exp.start()

    exp.capture(makeRecord(1))
    exp.capture(makeRecord(2))
    await exp.stop()

    expect(sink.appended).toHaveLength(2)

    // After stop, capture is a no-op
    exp.capture(makeRecord(3))
    await exp.flush()
    expect(sink.appended).toHaveLength(2)
  })

  it('drops oldest records when buffer exceeds maxBufferSize', async () => {
    const dropped: number[] = []
    const sink = new NullTelemetrySink()
    const exp = new TelemetryExporter({
      sink,
      maxBufferSize: 3,
      onDrop: (count, reason) => {
        if (reason === 'buffer-overflow') dropped.push(count)
      },
    })

    for (let i = 1; i <= 5; i++) exp.capture(makeRecord(i))
    expect(exp.bufferSize).toBe(3)
    expect(dropped).toEqual([1, 1])  // two single-record drops
  })

  it('re-buffers records when the sink throws and invokes onDrop with sink-error', async () => {
    const errors: unknown[] = []
    let attempts = 0
    const sink: TelemetrySink = {
      append: async () => {
        attempts++
        if (attempts === 1) throw new Error('disk full')
      },
    }
    const exp = new TelemetryExporter({
      sink,
      onDrop: (_count, reason, err) => {
        if (reason === 'sink-error') errors.push(err)
      },
    })

    exp.capture(makeRecord(1))
    exp.capture(makeRecord(2))
    await exp.flush()

    expect(errors).toHaveLength(1)
    expect(exp.bufferSize).toBe(2)  // records returned to buffer

    // Retry succeeds
    await exp.flush()
    expect(exp.bufferSize).toBe(0)
    expect(attempts).toBe(2)
  })
})

// ── FileTelemetrySink ───────────────────────────────────────────────────────

describe('FileTelemetrySink', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `freerouter-telem-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'spend.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends one JSON object per line', async () => {
    const sink = new FileTelemetrySink({ filePath })
    await sink.append([makeRecord(1), makeRecord(2)])

    const raw = await readFile(filePath, 'utf8')
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).userId).toBe('u1')
    expect(JSON.parse(lines[1]!).userId).toBe('u2')
  })

  it('preserves all SpendRecord fields including optional ones', async () => {
    const record: SpendRecord = {
      userId: 'u1',
      orgId: 'org1',
      departmentId: 'dept1',
      teamId: 'team1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      tokens: { promptTokens: 200, completionTokens: 100, totalTokens: 300, cachedPromptTokens: 150 },
      costUsd: 0.0042,
      timestamp: 1_700_000_000_000,
      cachedPromptTokens: 150,
    }
    const sink = new FileTelemetrySink({ filePath })
    await sink.append([record])
    const raw = await readFile(filePath, 'utf8')
    expect(JSON.parse(raw.trimEnd())).toEqual(record)
  })

  it('appends across multiple calls — never truncates', async () => {
    const sink = new FileTelemetrySink({ filePath })
    await sink.append([makeRecord(1)])
    await sink.append([makeRecord(2), makeRecord(3)])

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('append() with empty array is a no-op (file not created)', async () => {
    const sink = new FileTelemetrySink({ filePath })
    await sink.append([])
    const { existsSync } = await import('node:fs')
    expect(existsSync(filePath)).toBe(false)
  })

  it('creates parent directories on first write', async () => {
    const nested = join(dir, 'a', 'b', 'c', 'spend.jsonl')
    const sink = new FileTelemetrySink({ filePath: nested })
    await sink.append([makeRecord(1)])
    const { existsSync } = await import('node:fs')
    expect(existsSync(nested)).toBe(true)
  })

  it('rotates the file when it exceeds maxBytes', async () => {
    const sink = new FileTelemetrySink({ filePath, maxBytes: 50 })
    // First write — small, no rotation yet.
    await sink.append([makeRecord(1)])
    const firstSize = (await stat(filePath)).size
    expect(firstSize).toBeGreaterThan(0)

    // Subsequent writes that push past maxBytes trigger a rotation
    // before the next append begins.
    await sink.append(Array.from({ length: 10 }, (_, i) => makeRecord(i + 2)))
    await sink.append([makeRecord(99)])

    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    const rotated = files.filter(f => f.startsWith('spend.jsonl.'))
    expect(rotated.length).toBeGreaterThanOrEqual(1)
  })

  it('maxBytes=0 disables rotation', async () => {
    const sink = new FileTelemetrySink({ filePath, maxBytes: 0 })
    for (let i = 1; i <= 50; i++) await sink.append([makeRecord(i)])
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    expect(files.filter(f => f.startsWith('spend.jsonl.'))).toHaveLength(0)
  })
})

// ── End-to-end: exporter + file sink ────────────────────────────────────────

describe('TelemetryExporter + FileTelemetrySink', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `freerouter-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'spend.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('captures, buffers, and persists records end-to-end', async () => {
    const sink = new FileTelemetrySink({ filePath })
    const exp = new TelemetryExporter({ sink })

    for (let i = 1; i <= 5; i++) exp.capture(makeRecord(i))
    await exp.flush()

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(5)
    const parsed = lines.map(l => JSON.parse(l))
    expect(parsed.map(p => p.userId)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5'])
  })

  it('stop() drains the buffer before exiting', async () => {
    const sink = new FileTelemetrySink({ filePath })
    const exp = new TelemetryExporter({ sink, intervalMs: 60_000 })
    exp.start()

    exp.capture(makeRecord(1))
    await exp.stop()

    const raw = await readFile(filePath, 'utf8')
    expect(raw.trimEnd().split('\n')).toHaveLength(1)
  })
})
