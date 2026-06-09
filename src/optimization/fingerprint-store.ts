import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs'
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
  /** Minimum ms between disk persists of the candidate index. 0 = persist on every refresh (default). */
  persistIntervalMs?: number
}

/** Persists the lightweight candidate index and captures capped references. */
export class FingerprintStore {
  private readonly index = new Map<string, CandidateEntry>()
  // In-memory only: resets on process restart, so the per-fingerprint cap is
  // best-effort across restarts. Intentional — references are optimizer training
  // data, not hard-bounded; counting on-disk lines per call isn't worth the I/O.
  private readonly refCounts = new Map<string, number>()
  private readonly maxRefs: number
  private mtimeMs = 0
  private lastPersist = 0
  private readonly persistIntervalMs: number

  constructor(private readonly cfg: FingerprintStoreConfig) {
    this.maxRefs = cfg.maxReferencesPerFingerprint ?? 10
    this.persistIntervalMs = cfg.persistIntervalMs ?? 0
  }

  /** Read the candidate index from disk. Call before get()/all(). No-op if the file is absent. */
  load(): void {
    if (!existsSync(this.cfg.candidatesPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.cfg.candidatesPath, 'utf-8')) as CandidateEntry[]
      for (const e of raw) this.index.set(e.fingerprint, e)
      this.mtimeMs = statSync(this.cfg.candidatesPath).mtimeMs
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

  /** Merge freshly-computed candidates into the index, reconcile on-disk status
   *  changes from external writers (e.g. the config-manager GUI), and persist
   *  (throttled by persistIntervalMs when set). */
  refreshCandidates(fresh: CandidateEntry[]): void {
    this.reconcileStatusesFromDisk()
    for (const c of fresh) {
      const prior = this.index.get(c.fingerprint)
      this.index.set(c.fingerprint, prior !== undefined && prior.status !== 'observed'
        ? { ...c, status: prior.status }
        : c)
    }
    const now = Date.now()
    if (this.persistIntervalMs <= 0 || now - this.lastPersist >= this.persistIntervalMs) {
      this.persist()
      this.lastPersist = now
    }
  }

  persist(): void {
    const path = this.cfg.candidatesPath
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf-8')
    renameSync(tmp, path)
    try { this.mtimeMs = statSync(path).mtimeMs } catch { /* ignore */ }
  }

  /** Adopt status changes written to the candidates file by another writer
   *  (e.g. the config-manager GUI) without losing our fresher counts. */
  private reconcileStatusesFromDisk(): void {
    const path = this.cfg.candidatesPath
    if (!existsSync(path)) return
    try {
      const m = statSync(path).mtimeMs
      if (m === this.mtimeMs) return
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as CandidateEntry[]
      for (const e of raw) {
        const cur = this.index.get(e.fingerprint)
        if (cur === undefined) {
          this.index.set(e.fingerprint, e)
        } else if (e.status !== 'observed') {
          cur.status = e.status
        }
      }
      this.mtimeMs = m
    } catch { /* ignore malformed/racy reads; keep current in-memory state */ }
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
