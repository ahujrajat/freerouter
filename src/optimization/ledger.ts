export interface LedgerEntry {
  classSignature: string
  /** Tenancy scope this entry was recorded under (e.g. "org:acme"). */
  scope: string
  targetModel: string
  fallbackModel: string
  /** Total USD spent on GEPA optimization for this class so far. */
  optimizationUsd: number
  /** Sum of `(fallbackCost - actualCost)` over served requests. */
  realizedSavingsUsd: number
  /** Count of requests served by the optimized template. */
  servedRequests: number
  /** Quality-gate failures since last reset. */
  qualityFailures: number
  /** Most recent quality score (0–1). */
  lastQualityScore?: number
  /** When this entry was created or last reset. */
  createdAt: number
  /** Last time `servedRequests` ticked or quality was updated. */
  updatedAt: number
  /** When the class is flagged `optimization_disabled`, until this epoch ms. */
  disabledUntil?: number
}

export interface LedgerScopeKey {
  scope: 'global' | 'org' | 'team' | 'user'
  orgId?: string
  teamId?: string
  userId?: string
}

function scopeString(key: LedgerScopeKey): string {
  switch (key.scope) {
    case 'global': return 'global'
    case 'org':    return `org:${key.orgId ?? '__no_org__'}`
    case 'team':   return `team:${key.orgId ?? '__no_org__'}/${key.teamId ?? '__no_team__'}`
    case 'user':   return `user:${key.userId ?? '__no_user__'}`
  }
}

/**
 * Tracks return-on-investment of every GEPA optimization run.
 *
 * Closes the cost loop described in §5 of the per-request mode plan:
 * - Every optimization run reports `optimizationUsd` (reflection + judge cost).
 * - Every served request reports its realized savings.
 * - Classes with cumulative ROI < 1 after `minObservationRequests` get flagged
 *   `optimization_disabled` for a cooldown window; subsequent requests skip
 *   the GEPA call and route directly to the fallback model.
 */
export class OptimizationLedger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly minObservationRequests: number
  private readonly cooldownMs: number

  constructor(opts: { minObservationRequests?: number; cooldownMs?: number } = {}) {
    this.minObservationRequests = opts.minObservationRequests ?? 50
    this.cooldownMs = opts.cooldownMs ?? 86_400_000  // 24 h
  }

  private keyOf(classSig: string, scope: LedgerScopeKey): string {
    return `${scopeString(scope)}|${classSig}`
  }

  private upsert(key: string, classSig: string, scope: LedgerScopeKey,
                 targetModel: string, fallbackModel: string): LedgerEntry {
    let e = this.entries.get(key)
    if (e === undefined) {
      const now = Date.now()
      e = {
        classSignature: classSig,
        scope: scopeString(scope),
        targetModel,
        fallbackModel,
        optimizationUsd: 0,
        realizedSavingsUsd: 0,
        servedRequests: 0,
        qualityFailures: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.entries.set(key, e)
    }
    return e
  }

  /** Called by the bridge after a successful optimization run. */
  recordOptimization(params: {
    classSignature: string
    scope: LedgerScopeKey
    targetModel: string
    fallbackModel: string
    optimizationUsd: number
    qualityScore: number
  }): void {
    const key = this.keyOf(params.classSignature, params.scope)
    const e = this.upsert(key, params.classSignature, params.scope, params.targetModel, params.fallbackModel)
    e.optimizationUsd += params.optimizationUsd
    e.lastQualityScore = params.qualityScore
    e.updatedAt = Date.now()
  }

  /** Called by the router after each request served by an optimized template. */
  recordRequest(params: {
    classSignature: string
    scope: LedgerScopeKey
    actualCostUsd: number
    fallbackCostUsd: number
  }): void {
    const key = this.keyOf(params.classSignature, params.scope)
    const e = this.entries.get(key)
    if (e === undefined) return
    e.servedRequests += 1
    e.realizedSavingsUsd += (params.fallbackCostUsd - params.actualCostUsd)
    e.updatedAt = Date.now()

    if (e.servedRequests >= this.minObservationRequests && this.roi(e) < 1) {
      e.disabledUntil = Date.now() + this.cooldownMs
    }
  }

  /** Called when the runtime quality gate detects a regression. */
  recordQualityFailure(classSig: string, scope: LedgerScopeKey): void {
    const e = this.entries.get(this.keyOf(classSig, scope))
    if (e === undefined) return
    e.qualityFailures += 1
    e.updatedAt = Date.now()
  }

  /**
   * Returns the per-request expected savings × historical ROI factor used by
   * `ComplexityGate.expectedROI`. Returns 0 for classes that are disabled or
   * have no positive track record yet.
   */
  classPrior(classSig: string, scope: LedgerScopeKey): number {
    const e = this.entries.get(this.keyOf(classSig, scope))
    if (e === undefined) return 1   // unseen class — neutral prior
    if (e.disabledUntil !== undefined && e.disabledUntil > Date.now()) return 0
    const r = this.roi(e)
    // Clamp to [0, 1.5] so a very profitable class can boost but never explode.
    if (!Number.isFinite(r)) return 1
    return Math.max(0, Math.min(1.5, r))
  }

  isDisabled(classSig: string, scope: LedgerScopeKey): boolean {
    const e = this.entries.get(this.keyOf(classSig, scope))
    if (e === undefined || e.disabledUntil === undefined) return false
    return e.disabledUntil > Date.now()
  }

  /** Resets the disabled flag (e.g. after retraining). */
  reset(classSig: string, scope: LedgerScopeKey): void {
    this.entries.delete(this.keyOf(classSig, scope))
  }

  snapshot(): LedgerEntry[] {
    return [...this.entries.values()]
  }

  private roi(e: LedgerEntry): number {
    if (e.optimizationUsd <= 0) return Number.POSITIVE_INFINITY
    return e.realizedSavingsUsd / e.optimizationUsd
  }
}
