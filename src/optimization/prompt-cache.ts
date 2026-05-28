export type CacheScope = 'global' | 'org' | 'team' | 'user'

export interface CacheKeyInput {
  classSignature: string
  targetModel: string
  scope: CacheScope
  orgId?: string
  teamId?: string
  userId: string
}

export interface OptimizedTemplate {
  /** System prompt or scaffold the optimizer produced. */
  template: string
  /** Free-form metadata for the ledger (e.g. optimization run id). */
  meta?: Record<string, unknown>
}

interface Entry {
  key: string
  value: OptimizedTemplate
  expiresAt: number
}

export interface PromptCacheConfig {
  /** Max entries before LRU eviction. Default 5_000. */
  maxEntries?: number
  /** Time-to-live for an entry in ms. Default 86_400_000 (24 h). */
  ttlMs?: number
  /** Scoping policy applied when computing keys. Default 'org'. */
  scope?: CacheScope
}

/**
 * Tenancy-scoped LRU cache for optimized prompt templates.
 *
 * Keys are deterministic functions of (classSignature, targetModel, scope, tenant),
 * so two requests from the same org with the same class signature collide and
 * share an optimized prompt; cross-org collisions never happen.
 *
 * No async work in the hot path: get/set are O(1) (Map + insertion-order
 * iteration for LRU eviction).
 */
export class PromptCache {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly scope: CacheScope

  constructor(config: PromptCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? 5_000
    this.ttlMs      = config.ttlMs ?? 86_400_000
    this.scope      = config.scope ?? 'org'
  }

  /** Compute the cache key for the configured scope. */
  keyFor(input: CacheKeyInput): string {
    const scope = input.scope ?? this.scope
    const tenant =
      scope === 'global' ? '*'
      : scope === 'org'  ? (input.orgId ?? '__no_org__')
      : scope === 'team' ? `${input.orgId ?? '__no_org__'}/${input.teamId ?? '__no_team__'}`
      : input.userId
    return `${scope}|${tenant}|${input.targetModel}|${input.classSignature}`
  }

  get(input: CacheKeyInput): OptimizedTemplate | undefined {
    const key = this.keyFor(input)
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // LRU touch: re-insert at the tail.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(input: CacheKeyInput, value: OptimizedTemplate): void {
    const key = this.keyFor(input)
    this.entries.delete(key)
    this.entries.set(key, { key, value, expiresAt: Date.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  invalidate(input: CacheKeyInput): boolean {
    return this.entries.delete(this.keyFor(input))
  }

  clear(): void {
    this.entries.clear()
  }

  /** For tests / instrumentation. */
  get size(): number {
    return this.entries.size
  }
}
