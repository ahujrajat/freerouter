import type { BudgetPolicy, ChatRequest, Message, RequestContext, SpendRecord, TokenUsage } from '../types.js'
import type { CostOptimizationConfig } from './cost-router.js'
import type { Rule, RulesMode } from './rules-engine.js'
import { BaseProvider, type ProviderPricing } from '../providers/base-provider.js'
import { ProviderRegistry } from '../providers/registry.js'
import { SpendTracker } from './spend-tracker.js'
import { PolicyEngine } from './policy-engine.js'
import { CostRouter } from './cost-router.js'
import { RulesEngine, type RuleDecision } from './rules-engine.js'
import { calculateCost, estimatePromptTokens } from './cost-calculator.js'

/**
 * Pricing snapshot for replay: {provider: {model: {input, output, cachedInput?}}}.
 * The GEPA sidecar passes this in alongside the candidate config so scoring is
 * fully deterministic and doesn't depend on live provider pricing.
 */
export type ReplayPricingMap = Record<string, Record<string, ProviderPricing & { cachedInput?: number }>>

/**
 * Routing prefixes per provider (lowercase). Matches DEFAULT_PREFIX_MAP in
 * `ProviderRegistry`. Used to register replay providers so bare model names
 * (returned by `CostRouter`) resolve correctly.
 */
const DEFAULT_REPLAY_PREFIXES: Record<string, string[]> = {
  google:    ['gemini'],
  openai:    ['gpt', 'o3', 'o4'],
  anthropic: ['claude'],
  mistral:   ['mistral', 'mixtral', 'codestral'],
  groq:      ['llama', 'gemma'],
}

export interface ReplayCandidateConfig {
  /** Optional admin rules. Same shape as RouterConfig.rules. */
  rules?: { rules: Rule[]; mode: RulesMode }
  /** Cost-optimization config. */
  costOptimization?: CostOptimizationConfig
  /** Budget policies. */
  budgets?: BudgetPolicy[]
  /** Per-model pricing overrides (provider-prefixed key). */
  pricingOverrides?: Record<string, { input: number; output: number; cachedInput?: number }>
  /** Default provider for slash-less model strings. */
  defaultProvider?: string
}

export interface ReplayDecision {
  /** Final model the candidate config would have routed to. */
  effectiveModel: string
  /** Estimated cost in USD using candidate pricing + token estimate. */
  estimatedCostUsd: number
  /** Whether the candidate allowed the request through. */
  allowed: boolean
  /** Block reason, if any. */
  blockedReason?: string
  /** Whether the candidate downgraded the model. */
  downgraded: boolean
  /** ID of the rule that fired, if any. */
  ruleId?: string
  /** ID of the policy that fired, if any. */
  policyId?: string
}

export interface ReplayAggregate {
  recordsScored: number
  baselineCostUsd: number
  candidateCostUsd: number
  savingsUsd: number
  savingsPct: number
  blocks: number
  realtimeBlocks: number
  downgrades: number
  modelSwitches: number
  /** Buckets {origModel→{newModel→count}}. */
  routingMatrix: Record<string, Record<string, number>>
  /** Per-org cost delta in USD (candidate − baseline; negative = savings). */
  costDeltaByOrg: Record<string, number>
}

function stripProviderPrefix(model: string): string {
  const i = model.indexOf('/')
  return i > 0 ? model.slice(i + 1) : model
}

class ReplayProvider extends BaseProvider {
  readonly name: string
  private readonly prices: Record<string, ProviderPricing & { cachedInput?: number }>

  constructor(name: string, prices: Record<string, ProviderPricing & { cachedInput?: number }>) {
    super()
    this.name = name
    this.prices = prices
  }

  async chat(): Promise<never> {
    throw new Error('[ReplayProvider] chat() not supported in replay mode')
  }

  async *chatStream(): AsyncGenerator<never> {
    throw new Error('[ReplayProvider] chatStream() not supported in replay mode')
  }

  pricing(model: string): ProviderPricing {
    const exact = this.prices[model]
    if (exact !== undefined) return exact
    // Prefix-match (e.g. "gpt-4o-2024-11" → "gpt-4o")
    for (const [key, entry] of Object.entries(this.prices)) {
      if (model.startsWith(key)) return entry
    }
    // Conservative default — matches BaseProvider semantics.
    return { input: 0, output: 0 }
  }
}

/**
 * Replays historical `SpendRecord`s against a candidate `RouterConfig` and
 * aggregates cost, block-rate, and routing-switch metrics.
 *
 * The scorer uses the *real* `RulesEngine`, `CostRouter`, and `PolicyEngine` so
 * scoring decisions match what the live router would have made. Pricing is
 * resolved from an injected `ReplayPricingMap` (no live provider calls).
 *
 * Limitations: `SpendRecord` does not carry the original prompt content, so
 * the replay reconstructs a synthetic `ChatRequest` whose messages are an empty
 * shell sized to match the original token count. This is sufficient for
 * cost/policy scoring but cannot exercise InputValidator or content-aware
 * rules (rules matching on `metadata` will not match synthetic requests).
 */
export class ReplayScorer {
  private readonly registry: ProviderRegistry
  private readonly tracker: SpendTracker
  private readonly policyEngine: PolicyEngine
  private readonly costRouter: CostRouter | undefined
  private readonly rulesEngine: RulesEngine | undefined

  constructor(
    candidate: ReplayCandidateConfig,
    pricing: ReplayPricingMap,
    providerPrefixes: Record<string, string[]> = DEFAULT_REPLAY_PREFIXES,
  ) {
    // Start from an empty registry: disable every built-in provider so their
    // hardcoded pricing never leaks into replay decisions.
    const disableAllBuiltins = {
      google:    { enabled: false },
      openai:    { enabled: false },
      anthropic: { enabled: false },
      mistral:   { enabled: false },
      groq:      { enabled: false },
    }
    this.registry = new ProviderRegistry([], disableAllBuiltins)

    for (const [providerName, models] of Object.entries(pricing)) {
      const provider = new ReplayProvider(providerName, models)
      const prefixes = providerPrefixes[providerName] ?? []
      // Factory-register so prefix routing is wired up.
      this.registry.registerFactory(providerName, () => provider, prefixes)
      for (const [modelId, entry] of Object.entries(models)) {
        this.registry.addModelPricing(providerName, modelId, entry)
      }
    }

    this.tracker = new SpendTracker()
    this.policyEngine = new PolicyEngine(
      this.registry,
      this.tracker,
      undefined,
      undefined,
      candidate.budgets ?? [],
      candidate.pricingOverrides ?? {},
    )
    this.costRouter = candidate.costOptimization !== undefined
      ? new CostRouter(this.registry, candidate.costOptimization)
      : undefined
    this.rulesEngine = candidate.rules !== undefined
      ? new RulesEngine(candidate.rules)
      : undefined
  }

  /**
   * Score the candidate against a stream of historical records.
   *
   * Records are replayed in timestamp order; the internal `SpendTracker`
   * accumulates so budget caps behave realistically. Historical timestamps
   * are normalized to a tight window ending "now" so policy windows (which
   * compare against `Date.now()`) include every replayed record.
   */
  score(records: readonly SpendRecord[]): ReplayAggregate {
    const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp)
    const now = Date.now()
    // Re-stamp records so the oldest sits 1 ms in the past and they preserve
    // their original ordering. This keeps every record inside any policy window
    // longer than `records.length` ms (i.e., effectively always).
    const restamped = ordered.map((r, i) => ({
      ...r,
      timestamp: now - (ordered.length - i),
    }))
    const agg: ReplayAggregate = {
      recordsScored: 0,
      baselineCostUsd: 0,
      candidateCostUsd: 0,
      savingsUsd: 0,
      savingsPct: 0,
      blocks: 0,
      realtimeBlocks: 0,
      downgrades: 0,
      modelSwitches: 0,
      routingMatrix: {},
      costDeltaByOrg: {},
    }

    for (const rec of restamped) {
      const decision = this.scoreOne(rec)
      // Recompute candidate cost using the original token breakdown so the
      // baseline-vs-candidate comparison is apples-to-apples (both pricing
      // applied to the same usage). `decision.estimatedCostUsd` is the
      // pre-flight estimate the *live* policy engine would have produced;
      // we keep it on the per-decision object for callers that want it.
      const candidateCost = this.actualCostForCandidate(rec, decision.effectiveModel)
      agg.recordsScored++
      agg.baselineCostUsd += rec.costUsd
      agg.candidateCostUsd += decision.allowed ? candidateCost : 0

      if (!decision.allowed) {
        agg.blocks++
        // SpendRecord has no explicit priority field — treat all replay blocks
        // as potentially-realtime to be conservative for SLA scoring.
        agg.realtimeBlocks++
      }
      if (decision.downgraded) agg.downgrades++
      if (decision.effectiveModel !== rec.model) {
        agg.modelSwitches++
        const row = agg.routingMatrix[rec.model] ?? {}
        row[decision.effectiveModel] = (row[decision.effectiveModel] ?? 0) + 1
        agg.routingMatrix[rec.model] = row
      }

      const orgKey = rec.orgId ?? '__no_org__'
      const delta = (decision.allowed ? candidateCost : 0) - rec.costUsd
      agg.costDeltaByOrg[orgKey] = (agg.costDeltaByOrg[orgKey] ?? 0) + delta

      // Feed allowed records back into the tracker so budget caps accrue.
      if (decision.allowed) {
        this.tracker.recordSpend({
          ...rec,
          model: decision.effectiveModel,
          costUsd: decision.estimatedCostUsd,
        })
      }
    }

    agg.savingsUsd = agg.baselineCostUsd - agg.candidateCostUsd
    agg.savingsPct = agg.baselineCostUsd > 0 ? agg.savingsUsd / agg.baselineCostUsd : 0
    return agg
  }

  /**
   * Compute the cost the candidate would have incurred for this record's
   * actual token usage, billed at the chosen model's pricing.
   */
  private actualCostForCandidate(rec: SpendRecord, effectiveModel: string): number {
    try {
      const { provider, modelName } = this.registry.resolveFromModel(effectiveModel)
      const pricing = provider.pricing(modelName)
      return calculateCost(rec.tokens, pricing)
    } catch {
      return 0
    }
  }

  /**
   * Feed an actual spend record into the replay tracker so subsequent
   * `evaluateRequest()` calls see the accumulated spend.
   * Used by `ShadowRouter` to keep the shadow's budget state in sync with
   * the live router.
   */
  recordSpend(record: SpendRecord): void {
    this.tracker.recordSpend(record)
  }

  /**
   * Pure routing decision: rules → cost router → policy engine.
   * Takes a fully-formed `ChatRequest` (real or synthesized) and returns
   * what the candidate config would have done. Shared by `scoreOne` (replay)
   * and `ShadowRouter.evaluate` (live shadow mode).
   */
  evaluateRequest(userId: string, req: ChatRequest, ctx: RequestContext): ReplayDecision {
    // ── 1. Rules ──
    const ruleDecision: RuleDecision = this.rulesEngine?.evaluate(userId, req, ctx) ?? { kind: 'noop' }
    if (ruleDecision.kind === 'block') {
      return {
        effectiveModel: stripProviderPrefix(req.model),
        estimatedCostUsd: 0,
        allowed: false,
        blockedReason: `Rule "${ruleDecision.ruleId}": ${ruleDecision.reason}`,
        downgraded: false,
        ruleId: ruleDecision.ruleId,
      }
    }

    // ── 2. Cost router (mediated by rule mode) ──
    const optimizedModel = this.applyRuleAndCost(req, ruleDecision)
    const effectiveReq: ChatRequest = optimizedModel !== req.model
      ? { ...req, model: optimizedModel }
      : req

    // ── 3. Policy ──
    let decision
    try {
      decision = this.policyEngine.evaluate(userId, effectiveReq, ctx)
    } catch (err) {
      // Unknown provider/model in candidate config → treat as block.
      return {
        effectiveModel: stripProviderPrefix(optimizedModel),
        estimatedCostUsd: 0,
        allowed: false,
        blockedReason: `Policy evaluation failed: ${(err as Error).message}`,
        downgraded: false,
        ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
      }
    }

    return {
      effectiveModel: stripProviderPrefix(decision.effectiveModel),
      estimatedCostUsd: decision.estimatedCostUsd,
      allowed: decision.allowed,
      ...(decision.blockedReason !== undefined && { blockedReason: decision.blockedReason }),
      downgraded: decision.effectiveModel !== effectiveReq.model,
      ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
      ...(decision.policyId !== undefined && { policyId: decision.policyId }),
    }
  }

  /** Score a single record. Exposed for parity tests. */
  scoreOne(rec: SpendRecord): ReplayDecision {
    const req = this.synthesizeRequest(rec)
    const ctx: RequestContext = {
      ...(rec.orgId !== undefined && { orgId: rec.orgId }),
      ...(rec.teamId !== undefined && { teamId: rec.teamId }),
      ...(rec.departmentId !== undefined && { departmentId: rec.departmentId }),
    }
    return this.evaluateRequest(rec.userId, req, ctx)
  }

  /**
   * Mirror of `FinRouter.applyRuleAndCost` — kept in parity by the
   * `replay-scorer.test.ts` dual-runner test against the live router.
   */
  private applyRuleAndCost(req: ChatRequest, ruleDecision: RuleDecision): string {
    const tokens = estimatePromptTokens(req.messages)
    const isRealtime = req.priority === 'realtime'
    const mode = this.rulesEngine?.mode ?? 'pin-wins'

    if (ruleDecision.kind === 'noop') {
      if (this.costRouter === undefined) return req.model
      return this.costRouter.selectModel(req.model, tokens, isRealtime)
    }

    if (ruleDecision.kind === 'pin') {
      if (mode === 'pin-wins') return ruleDecision.model
      if (mode === 'narrow-candidates') {
        if (this.costRouter === undefined) return ruleDecision.model
        return this.costRouter.selectModel(req.model, tokens, isRealtime, {
          candidateModels: [ruleDecision.model],
        })
      }
      return ruleDecision.model
    }

    if (ruleDecision.kind === 'strategy') {
      if (this.costRouter === undefined) return req.model
      return this.costRouter.selectModel(req.model, tokens, isRealtime, {
        strategy: ruleDecision.strategy,
        ...(ruleDecision.candidateModels !== undefined && { candidateModels: ruleDecision.candidateModels }),
      })
    }
    return req.model
  }

  /**
   * Build a synthetic `ChatRequest` whose `messages` produce approximately
   * the same prompt-token count as the original. The actual content is empty
   * filler — replay cannot reconstruct the prompt body from `SpendRecord`.
   */
  private synthesizeRequest(rec: SpendRecord): ChatRequest {
    const usage: TokenUsage = rec.tokens
    // estimatePromptTokens uses ~4 chars per ASCII token + 4 tokens overhead per message.
    const approxChars = Math.max(0, usage.promptTokens * 4 - 4)
    const filler = approxChars > 0 ? '.'.repeat(approxChars) : ''
    const messages: Message[] = [{ role: 'user', content: filler }]
    return {
      model: rec.model.indexOf('/') < 0 ? `${rec.provider}/${rec.model}` : rec.model,
      messages,
    }
  }
}
