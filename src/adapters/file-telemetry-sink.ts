import { appendFile, mkdir, stat, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SpendRecord } from '../types.js'
import type { TelemetrySink } from '../finops/telemetry-sink.js'

export interface FileTelemetrySinkOptions {
  /** Output path, e.g. './telemetry/spend.jsonl' */
  filePath: string
  /**
   * When the live file grows past this size in bytes, it is rotated by renaming
   * to `<filePath>.<epochMs>` and a fresh file starts. Set to 0 to disable.
   * Default: 64 MiB.
   */
  maxBytes?: number
}

/**
 * Append-only JSONL telemetry sink. One `SpendRecord` per line.
 *
 * Format is intentionally minimal — the raw `SpendRecord` shape with no
 * envelope. Forward-compat additions go in a wrapper later if needed; for now
 * the file is trivially parsed by any JSONL reader (`jq -c`, pandas, polars).
 *
 * Concurrency contract: the sink expects the caller (`TelemetryExporter`) to
 * serialize `append()` calls. Multiple processes writing to the same file
 * concurrently is unsupported — point each process at a distinct path.
 */
export class FileTelemetrySink implements TelemetrySink {
  private readonly filePath: string
  private readonly maxBytes: number
  private dirEnsured = false

  constructor(opts: FileTelemetrySinkOptions) {
    this.filePath = opts.filePath
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  }

  async append(records: readonly SpendRecord[]): Promise<void> {
    if (records.length === 0) return

    if (!this.dirEnsured) {
      await mkdir(dirname(this.filePath), { recursive: true })
      this.dirEnsured = true
    }

    if (this.maxBytes > 0) {
      try {
        const s = await stat(this.filePath)
        if (s.size >= this.maxBytes) {
          await rename(this.filePath, `${this.filePath}.${Date.now()}`)
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    let payload = ''
    for (const r of records) {
      payload += JSON.stringify(r)
      payload += '\n'
    }
    await appendFile(this.filePath, payload, 'utf8')
  }
}
