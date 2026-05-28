import type { ChatRequest, Message, RequestContext } from '../types.js'
import type { PromptOptimizationConfig } from '../config.js'
import { RequestClassifier } from './classifier.js'
import { PromptCache } from './prompt-cache.js'
import { GepaBridge } from './gepa-bridge.js'
import { OptimizationLedger, type LedgerScopeKey } from './ledger.js'
import { ComplexityGate, type GateDecision } from './complexity-gate.js'

export interface PipelineOutcome {
  /** Model the request should be dispatched to. */
  model: string
  /** Optional system prompt to prepend to the request (from optimized template). */
  systemPrompt?: string
  /** What the gate decided. Surfaced for audit logging. */
  gate: GateDecision
  /** Whether an optimization was triggered (cache miss → sidecar call). */
  triggeredOptimization: boolean
  /** Sidecar status, if optimization was triggered. */
  optimizationStatus?: string
}

/**
 * Orchestrates per-request GEPA optimization: classify → gate → cache lookup
 * → (optional) sidecar call → ledger update.
 *
 * Lives outside the router so the per-request feature can be unit-tested in
 * isolation. The router calls `apply(req, ctx, userId)` after the standard
 * routing pipeline and before provider dispatch.
 */
export class OptimizationPipeline {
  private readonly cfg: PromptOptimizationConfig
  private readonly classifier: RequestClassifier
  private readonly cache: PromptCache
  private readonly bridge: GepaBridge
  private readonly ledger: OptimizationLedger
  private readonly gate: ComplexityGate

  constructor(cfg: PromptOptimizationConfig) {
    this.cfg = cfg
    this.classifier = new RequestClassifier(cfg.classifier ?? { strategy: 'rule-based' })
    this.cache  = new PromptCache(cfg.cache ?? {})
    this.bridge = new GepaBridge(cfg.bridge)
    this.ledger = new OptimizationLedger()
    this.gate   = new ComplexityGate(this.classifier, this.ledger, cfg.gate)
  }

  async apply(req: ChatRequest, ctx: RequestContext, userId: string): Promise<PipelineOutcome> {
    if (!this.cfg.enabled || this.cfg.mode === 'off') {
      return {
        model: req.model,
        gate: { action: 'direct-target', classification: { signature: 'disabled' }, complexityScore: 0,
                expectedRoiUsd: 0, rationale: 'promptOptimization.enabled=false' },
        triggeredOptimization: false,
      }
    }

    const decision = this.gate.evaluate(req, ctx, userId)
    const scopeKey: LedgerScopeKey = { scope: 'org', ...(ctx.orgId !== undefined && { orgId: ctx.orgId }) }

    if (decision.action === 'fallback') {
      return { model: this.cfg.fallbackModel, gate: decision, triggeredOptimization: false }
    }
    if (decision.action === 'direct-target') {
      return { model: this.cfg.targetModel, gate: decision, triggeredOptimization: false }
    }

    // ── 'optimize' branch ──
    const cacheKey = {
      classSignature: decision.classification.signature,
      targetModel: this.cfg.targetModel,
      scope: (this.cfg.cache?.scope ?? 'org') as 'global' | 'org' | 'team' | 'user',
      ...(ctx.orgId !== undefined && { orgId: ctx.orgId }),
      ...(ctx.teamId !== undefined && { teamId: ctx.teamId }),
      userId,
    }
    const hit = this.cache.get(cacheKey)
    if (hit !== undefined) {
      return {
        model: this.cfg.targetModel,
        systemPrompt: hit.template,
        gate: decision,
        triggeredOptimization: false,
      }
    }

    // Cache miss → sidecar call.
    const result = await this.bridge.optimize({
      classSignature: decision.classification.signature,
      targetModel: this.cfg.targetModel,
      fallbackModel: this.cfg.fallbackModel,
      sample: { messages: req.messages, model: req.model },
    })

    if (result.status === 'ok' && result.template !== undefined) {
      this.cache.set(cacheKey, result.template)
      this.ledger.recordOptimization({
        classSignature: decision.classification.signature,
        scope: scopeKey,
        targetModel: this.cfg.targetModel,
        fallbackModel: this.cfg.fallbackModel,
        optimizationUsd: result.optimizationUsd ?? 0,
        qualityScore: result.qualityScore ?? 0,
      })
      return {
        model: this.cfg.targetModel,
        systemPrompt: result.template.template,
        gate: decision,
        triggeredOptimization: true,
        optimizationStatus: result.status,
      }
    }

    // Optimization failed → fall back (default) or use unmodified target.
    const failClosed = this.cfg.failClosed ?? true
    return {
      model: failClosed ? this.cfg.fallbackModel : this.cfg.targetModel,
      gate: decision,
      triggeredOptimization: true,
      optimizationStatus: result.status,
    }
  }

  /**
   * Apply the optimized system prompt to the request's messages.
   * If a system message already exists it is prepended-to (not replaced).
   */
  injectSystemPrompt(req: ChatRequest, systemPrompt: string): ChatRequest {
    const messages: Message[] = []
    let injected = false
    for (const m of req.messages) {
      if (!injected && m.role === 'system') {
        messages.push({ role: 'system', content: `${systemPrompt}\n\n${m.content}` })
        injected = true
      } else {
        messages.push(m)
      }
    }
    if (!injected) {
      messages.unshift({ role: 'system', content: systemPrompt })
    }
    return { ...req, messages }
  }

  /** Forward a usage report to the ledger after the response completes. */
  recordUsage(params: {
    classSignature: string
    ctx: RequestContext
    actualCostUsd: number
    fallbackCostUsd: number
  }): void {
    const scopeKey: LedgerScopeKey = { scope: 'org', ...(params.ctx.orgId !== undefined && { orgId: params.ctx.orgId }) }
    this.ledger.recordRequest({
      classSignature: params.classSignature,
      scope: scopeKey,
      actualCostUsd: params.actualCostUsd,
      fallbackCostUsd: params.fallbackCostUsd,
    })
  }

  /** Snapshot of the ledger for telemetry / debugging. */
  ledgerSnapshot() {
    return this.ledger.snapshot()
  }
}
