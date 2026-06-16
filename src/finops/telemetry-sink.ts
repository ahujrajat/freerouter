import type { SpendRecord } from '../types.js'

/**
 * Append-only telemetry sink for completed-request records.
 *
 * Distinct from `SpendStore`: the store is a snapshot of the *current*
 * in-memory window (subject to pruning); the sink is a forward-only
 * stream of every record FinRouter has seen. Sinks feed offline
 * pipelines (analytics, GEPA optimizer, lakehouse loaders) that need
 * a complete history.
 *
 * Implementations must be safe to call repeatedly with disjoint batches.
 * The exporter serializes calls — implementations need not be reentrant.
 */
export interface TelemetrySink {
  append(records: readonly SpendRecord[]): Promise<void>
}

/** Discards records. Useful in tests where the exporter is exercised but I/O isn't. */
export class NullTelemetrySink implements TelemetrySink {
  async append(_records: readonly SpendRecord[]): Promise<void> {
    /* no-op */
  }
}

/** In-memory sink — retains the full append log for inspection in tests. */
export class MemoryTelemetrySink implements TelemetrySink {
  readonly appended: SpendRecord[] = []
  async append(records: readonly SpendRecord[]): Promise<void> {
    for (const r of records) this.appended.push(r)
  }
}
