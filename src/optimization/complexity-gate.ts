import type { ChatRequest, RequestContext } from '../types.js'
import type { OptimizationLedger, LedgerScopeKey } from './ledger.js'
import type { RequestClassifier, RequestClass } from './classifier.js'
import {
  extractFeatures, score as scoreComplexity,
  type HeuristicWeights, type SaturationConstants,
} from './complexity-heuristics.js'

export type GateAction = 'optimize' | 'direct-target' | 'fallback'

export interface GateDecision {
  action: GateAction
  classification: RequestClass
  complexityScore: number
  expectedRoiUsd: number
  /** Human-readable reason — used by audit logs and the optimization ledger. */
  rationale: string
}

export interface ComplexityGateConfig {
  /** Per-1M-token input price for the cheap target (USD). */
  targetInputPer1M: number
  /** Per-1M-token input price for the fallback "good" model (USD). */
  fallbackInputPer1M: number
  /** Required ROI threshold to trigger GEPA. Default: 0.002 USD/request. */
  minRoiUsd?: number
  /** Failure-risk threshold above which we skip cheap and go straight to fallback. */
  directFallbackRisk?: number
  /** Custom heuristic weights (offline-tuned). */
  heuristicWeights?: HeuristicWeights
  /** Custom saturation constants (offline-tuned). */
  saturation?: SaturationConstants
  /** Estimated reuse multiplier when a class is unseen. Default: 1. */
  defaultExpectedReuse?: number
  /** Static success-rate estimate for the cheap model when no telemetry. Default: 0.5. */
  defaultCheapModelSuccessRate?: number
}

export class ComplexityGate {
  constructor(
    private readonly classifier: RequestClassifier,
    private readonly ledger: OptimizationLedger,
    private readonly config: ComplexityGateConfig,
  ) {}

  evaluate(req: ChatRequest, ctx: RequestContext, userId: string): GateDecision {
    const classification = this.classifier.classify(req, ctx)
    const scopeKey: LedgerScopeKey = { scope: 'org', ...(ctx.orgId !== undefined && { orgId: ctx.orgId }) }

    // Disabled class → straight to direct-target (caller may swap to fallback).
    if (this.ledger.isDisabled(classification.signature, scopeKey)) {
      return {
        action: 'direct-target',
        classification,
        complexityScore: 0,
        expectedRoiUsd: 0,
        rationale: 'class flagged optimization_disabled in ledger',
      }
    }

    const features = extractFeatures(req.messages)
    const complexity = scoreComplexity(features, this.config.heuristicWeights, this.config.saturation)

    const cheapRate = this.config.defaultCheapModelSuccessRate ?? 0.5
    const failureRisk = 0.6 * complexity.score + 0.4 * (1 - cheapRate)

    const tokens = features.tokens
    const rateSpread = Math.max(0, this.config.fallbackInputPer1M - this.config.targetInputPer1M)
    const savingsPerRequestUsd = (tokens / 1_000_000) * rateSpread

    const reuse = this.config.defaultExpectedReuse ?? 1
    const prior = this.ledger.classPrior(classification.signature, scopeKey)
    const expectedRoiUsd = failureRisk * savingsPerRequestUsd * reuse * prior

    const minRoiUsd        = this.config.minRoiUsd ?? 0.002
    const directFallbackRisk = this.config.directFallbackRisk ?? 0.85

    if (expectedRoiUsd >= minRoiUsd) {
      return {
        action: 'optimize',
        classification,
        complexityScore: complexity.score,
        expectedRoiUsd,
        rationale: `ROI ${expectedRoiUsd.toFixed(4)} ≥ ${minRoiUsd}`,
      }
    }
    if (failureRisk >= directFallbackRisk) {
      return {
        action: 'fallback',
        classification,
        complexityScore: complexity.score,
        expectedRoiUsd,
        rationale: `failureRisk ${failureRisk.toFixed(2)} ≥ ${directFallbackRisk} (skip optimization)`,
      }
    }
    return {
      action: 'direct-target',
      classification,
      complexityScore: complexity.score,
      expectedRoiUsd,
      rationale: 'low expected ROI; cheap-model can handle directly',
    }
  }
}
