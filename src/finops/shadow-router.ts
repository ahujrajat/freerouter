import type { ChatRequest, RequestContext, SpendRecord } from '../types.js'
import { ReplayScorer, type ReplayCandidateConfig, type ReplayPricingMap } from './replay-scorer.js'

export interface ShadowDecisionRecord {
  timestamp: number
  userId: string
  orgId?: string
  /** Model the *live* router routed to. */
  liveModel: string
  /** Model the shadow candidate would have routed to. */
  shadowModel: string
  /** Actual cost incurred by the live request. */
  liveCostUsd: number
  /** Shadow's pre-flight estimate using its own pricing snapshot. */
  shadowEstimatedCostUsd: number
  /** Whether the shadow candidate would have allowed the request. */
  shadowAllowed: boolean
  shadowBlockedReason?: string
  shadowRuleId?: string
  shadowPolicyId?: string
}

export interface ShadowSink {
  record(decision: ShadowDecisionRecord): void | Promise<void>
}

/**
 * Append-only memory sink. Useful for tests and for offline export to JSONL.
 */
export class MemoryShadowSink implements ShadowSink {
  readonly records: ShadowDecisionRecord[] = []
  record(decision: ShadowDecisionRecord): void {
    this.records.push(decision)
  }
}

/**
 * Runs a candidate `RouterConfig` in parallel with the live router. Decisions
 * are computed in-memory (zero I/O, sub-millisecond) and emitted to a
 * `ShadowSink`. Responses to users are *never* affected — the shadow is
 * observational only.
 *
 * Wire it via `RouterConfig.shadowRouter` (Phase 4 plan).
 *
 * The shadow tracker accumulates real spend records (via `recordActualSpend`)
 * so budget windows reflect actual traffic. This is the key contract: the
 * shadow's "what would have happened" answers stay grounded in real history
 * even though it never directly affects routing.
 */
export class ShadowRouter {
  private readonly scorer: ReplayScorer

  constructor(candidate: ReplayCandidateConfig, pricing: ReplayPricingMap) {
    this.scorer = new ReplayScorer(candidate, pricing)
  }

  /**
   * Compute what the shadow candidate would have done for this request.
   * Caller invokes this synchronously alongside live routing.
   */
  evaluate(userId: string, req: ChatRequest, ctx: RequestContext) {
    return this.scorer.evaluateRequest(userId, req, ctx)
  }

  /**
   * Feed actual live spend into the shadow's tracker so its budget cascade
   * reflects current burn rate. Must be called after each completed request.
   */
  recordActualSpend(record: SpendRecord): void {
    this.scorer.recordSpend(record)
  }

  /**
   * Convenience: evaluate, build a comparison record against the live
   * outcome, and emit to the sink.
   */
  async observe(params: {
    userId: string
    req: ChatRequest
    ctx: RequestContext
    liveModel: string
    liveCostUsd: number
    sink: ShadowSink
  }): Promise<void> {
    const decision = this.evaluate(params.userId, params.req, params.ctx)
    const record: ShadowDecisionRecord = {
      timestamp: Date.now(),
      userId: params.userId,
      ...(params.ctx.orgId !== undefined && { orgId: params.ctx.orgId }),
      liveModel: params.liveModel,
      shadowModel: decision.effectiveModel,
      liveCostUsd: params.liveCostUsd,
      shadowEstimatedCostUsd: decision.estimatedCostUsd,
      shadowAllowed: decision.allowed,
      ...(decision.blockedReason !== undefined && { shadowBlockedReason: decision.blockedReason }),
      ...(decision.ruleId !== undefined && { shadowRuleId: decision.ruleId }),
      ...(decision.policyId !== undefined && { shadowPolicyId: decision.policyId }),
    }
    await params.sink.record(record)
  }
}
