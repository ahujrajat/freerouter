import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message } from '../types.js'

export type CandidateStatus = 'observed' | 'optimizing' | 'optimized' | 'rejected'

export interface CandidateEntry {
  fingerprint: string
  simhash: string
  model: string
  count: number
  totalCostUsd: number
  lastSeen: number
  estPredictedSavingsUsd: number
  estBreakEvenReqs: number
  sampleClassSignature: string
  status: CandidateStatus
}

export interface FingerprintStoreConfig {
  candidatesPath: string
  referencesDir: string
  captureReferences: boolean
  maxReferencesPerFingerprint?: number
}

/** Persists the lightweight candidate index and captures capped references. */
export class FingerprintStore {
  private readonly index = new Map<string, CandidateEntry>()
  // In-memory only: resets on process restart, so the per-fingerprint cap is
  // best-effort across restarts. Intentional — references are optimizer training
  // data, not hard-bounded; counting on-disk lines per call isn't worth the I/O.
  private readonly refCounts = new Map<string, number>()
  private readonly maxRefs: number

  constructor(private readonly cfg: FingerprintStoreConfig) {
    this.maxRefs = cfg.maxReferencesPerFingerprint ?? 10
  }

  /** Read the candidate index from disk. Call before get()/all(). No-op if the file is absent. */
  load(): void {
    if (!existsSync(this.cfg.candidatesPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.cfg.candidatesPath, 'utf-8')) as CandidateEntry[]
      for (const e of raw) this.index.set(e.fingerprint, e)
    } catch { /* malformed → start empty */ }
  }

  get(fingerprint: string): CandidateEntry | undefined {
    return this.index.get(fingerprint)
  }

  upsert(entry: CandidateEntry): void {
    this.index.set(entry.fingerprint, entry)
  }

  all(): CandidateEntry[] {
    return [...this.index.values()]
  }

  /** Merge freshly-computed candidates into the index and persist.
   *  Preserves a prior non-'observed' status (optimizing/optimized/rejected). */
  refreshCandidates(fresh: CandidateEntry[]): void {
    for (const c of fresh) {
      const prior = this.index.get(c.fingerprint)
      this.index.set(c.fingerprint, prior !== undefined && prior.status !== 'observed'
        ? { ...c, status: prior.status }
        : c)
    }
    this.persist()
  }

  persist(): void {
    const path = this.cfg.candidatesPath
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf-8')
    renameSync(tmp, path)
  }

  /** Append a {messages, output} reference for a fingerprint, capped per fingerprint. */
  captureReference(classSignature: string, messages: Message[], output: string): void {
    if (!this.cfg.captureReferences) return
    const used = this.refCounts.get(classSignature) ?? 0
    if (used >= this.maxRefs) return
    mkdirSync(this.cfg.referencesDir, { recursive: true })
    const safe = classSignature.replace(/[/:]/g, '_')
    const line = JSON.stringify({ messages, output })
    appendFileSync(join(this.cfg.referencesDir, `${safe}.jsonl`), line + '\n', 'utf-8')
    this.refCounts.set(classSignature, used + 1)
  }
}
