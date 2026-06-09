import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ChatRequest } from '../types.js'
import { simhash64, hammingDistance } from './simhash.js'

export interface OptimizedEntry {
  fingerprint: string
  simhash: string
  template: string
  qualityScore: number
  predictedSavingsUsd: number
  targetModel: string
  optimizedAt: number
}

export interface OptimizedStoreConfig {
  optimizedStorePath: string
  /** Max Hamming distance for a "similar" match. Default 3. */
  matchHammingDistance?: number
}

/** Loads optimized templates and matches incoming prompts by SimHash Hamming distance. */
export class OptimizedStore {
  private entries: OptimizedEntry[] = []
  private mtimeMs = 0
  private readonly maxDistance: number

  constructor(private readonly cfg: OptimizedStoreConfig) {
    this.maxDistance = cfg.matchHammingDistance ?? 3
  }

  load(): void {
    const path = this.cfg.optimizedStorePath
    if (!existsSync(path)) { this.entries = []; return }
    try {
      const mtime = statSync(path).mtimeMs
      this.entries = JSON.parse(readFileSync(path, 'utf-8')) as OptimizedEntry[]
      this.mtimeMs = mtime
    } catch {
      this.entries = []
    }
  }

  /** Reload only if the file changed on disk since the last load. */
  reloadIfChanged(): void {
    const path = this.cfg.optimizedStorePath
    if (!existsSync(path)) { this.entries = []; return }
    try {
      const m = statSync(path).mtimeMs
      if (m !== this.mtimeMs) this.load()
    } catch { /* keep current entries */ }
  }

  /** Return the closest optimized template within the Hamming threshold, or undefined. */
  match(req: ChatRequest): OptimizedEntry | undefined {
    if (this.entries.length === 0) return undefined
    const target = simhash64(req.messages.map(m => m.content).join(' '))
    let best: OptimizedEntry | undefined
    let bestDist = this.maxDistance + 1
    for (const e of this.entries) {
      const d = hammingDistance(target, e.simhash)
      if (d <= this.maxDistance && d < bestDist) { best = e; bestDist = d }
    }
    return best
  }
}
