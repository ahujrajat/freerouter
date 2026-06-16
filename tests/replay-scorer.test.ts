import { describe, it, expect } from 'vitest'
import { ReplayScorer, type ReplayCandidateConfig, type ReplayPricingMap } from '../src/finops/replay-scorer.js'
import type { SpendRecord } from '../src/types.js'

const PRICING: ReplayPricingMap = {
  openai: {
    'gpt-4o':      { input: 2.50, output: 10.00, cachedInput: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
  },
  google: {
    'gemini-2.0-flash':      { input: 0.10, output: 0.40 },
    'gemini-2.0-flash-lite': { input: 0.05, output: 0.20 },
  },
}

const rec = (overrides: Partial<SpendRecord> = {}): SpendRecord => ({
  userId: 'u1',
  orgId: 'acme',
  provider: 'openai',
  model: 'gpt-4o',
  tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  costUsd: 0.0075,
  timestamp: Date.now(),
  ...overrides,
})

describe('ReplayScorer — pass-through (no optimization)', () => {
  it('matches baseline cost when candidate has no rules and no cost router', () => {
    const scorer = new ReplayScorer({}, PRICING)
    const result = scorer.score([rec(), rec({ userId: 'u2' })])
    expect(result.recordsScored).toBe(2)
    expect(result.modelSwitches).toBe(0)
    expect(result.blocks).toBe(0)
    expect(result.savingsPct).toBeCloseTo(0, 5)
  })
})

describe('ReplayScorer — cost optimization', () => {
  const candidate: ReplayCandidateConfig = {
    costOptimization: {
      strategy: 'cheapest',
      candidateModels: ['gpt-4o-mini'],
    },
  }

  it('routes expensive gpt-4o requests to gpt-4o-mini', () => {
    const scorer = new ReplayScorer(candidate, PRICING)
    const result = scorer.score([rec()])
    expect(result.modelSwitches).toBe(1)
    expect(result.routingMatrix['gpt-4o']?.['gpt-4o-mini']).toBe(1)
    expect(result.candidateCostUsd).toBeLessThan(result.baselineCostUsd)
    expect(result.savingsPct).toBeGreaterThan(0)
  })

  it('respects minCostThresholdUsd by skipping cheap requests', () => {
    const scorer = new ReplayScorer({
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['gpt-4o-mini'],
        minCostThresholdUsd: 0.10,  // way above the per-request cost
      },
    }, PRICING)
    const result = scorer.score([rec()])
    expect(result.modelSwitches).toBe(0)
  })

  it('respects batchOnly=true for realtime requests', () => {
    const scorer = new ReplayScorer({
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['gpt-4o-mini'],
        batchOnly: true,
      },
    }, PRICING)
    // Synthesized requests have no priority field → not realtime → optimize
    // But the live router defaults to realtime when priority is undefined?
    // Looking at applyRuleAndCost: `isRealtime = req.priority === 'realtime'`.
    // Undefined → false → batch → eligible for optimization.
    const result = scorer.score([rec()])
    expect(result.modelSwitches).toBe(1)
  })
})

describe('ReplayScorer — admin rules', () => {
  it('blocks requests matching a block rule', () => {
    const scorer = new ReplayScorer({
      rules: {
        rules: [{ id: 'no-acme', action: { type: 'block', reason: 'blacklist' }, match: { orgId: 'acme' } }],
        mode: 'pin-wins',
      },
    }, PRICING)
    const result = scorer.score([rec(), rec({ orgId: 'other' })])
    expect(result.blocks).toBe(1)
    expect(result.realtimeBlocks).toBe(1)
    expect(result.recordsScored).toBe(2)
  })

  it('pins a specific model for matching requests', () => {
    const scorer = new ReplayScorer({
      rules: {
        rules: [{ id: 'pin-mini', action: { type: 'pin', model: 'gpt-4o-mini' }, match: { orgId: 'acme' } }],
        mode: 'pin-wins',
      },
    }, PRICING)
    const result = scorer.score([rec()])
    expect(result.modelSwitches).toBe(1)
    expect(result.routingMatrix['gpt-4o']?.['gpt-4o-mini']).toBe(1)
  })

  it('combines rules and cost router under narrow-candidates mode', () => {
    const scorer = new ReplayScorer({
      rules: {
        rules: [{ id: 'narrow', action: { type: 'pin', model: 'gpt-4o-mini' }, match: { orgId: 'acme' } }],
        mode: 'narrow-candidates',
      },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['gpt-4o-mini', 'gemini-2.0-flash-lite'],
      },
    }, PRICING)
    const result = scorer.score([rec()])
    expect(result.modelSwitches).toBe(1)
    expect(result.candidateCostUsd).toBeGreaterThan(0)
  })
})

describe('ReplayScorer — budget cascade', () => {
  it('blocks once monthly cap is exceeded', () => {
    const scorer = new ReplayScorer({
      budgets: [
        {
          id: 'tight',
          scope: { type: 'org', orgId: 'acme' },
          window: 'monthly',
          maxSpendUsd: 0.01,
          onLimitReached: 'block',
        },
      ],
    }, PRICING)
    // Each record costs ~0.0075 of pricing budget. Three records → cumulative
    // 0.0225 estimated cost (which is well above 0.01 cap). First record passes,
    // subsequent ones should block once budget is consumed.
    const records = [rec({ timestamp: 1 }), rec({ timestamp: 2 }), rec({ timestamp: 3 })]
    const result = scorer.score(records)
    expect(result.blocks).toBeGreaterThanOrEqual(1)
  })

  it('downgrades to fallback model when configured', () => {
    const scorer = new ReplayScorer({
      budgets: [
        {
          id: 'soft',
          scope: { type: 'org', orgId: 'acme' },
          window: 'monthly',
          maxSpendUsd: 0.005,
          onLimitReached: 'downgrade',
          fallbackModel: 'gpt-4o-mini',
        },
      ],
    }, PRICING)
    const result = scorer.score([rec({ timestamp: 1 }), rec({ timestamp: 2 })])
    expect(result.downgrades).toBeGreaterThanOrEqual(1)
  })
})

describe('ReplayScorer — aggregates', () => {
  it('records per-org cost delta', () => {
    const scorer = new ReplayScorer({
      costOptimization: { strategy: 'cheapest', candidateModels: ['gpt-4o-mini'] },
    }, PRICING)
    const result = scorer.score([
      rec({ orgId: 'a' }),
      rec({ orgId: 'b' }),
      rec({ orgId: 'b' }),
    ])
    expect(Object.keys(result.costDeltaByOrg).sort()).toEqual(['a', 'b'])
    expect(result.costDeltaByOrg.a).toBeLessThan(0)
    expect(result.costDeltaByOrg.b).toBeLessThan(result.costDeltaByOrg.a!)
  })

  it('replays records in timestamp order regardless of input order', () => {
    const scorer = new ReplayScorer({
      budgets: [
        { id: 'tiny', scope: { type: 'org', orgId: 'acme' }, window: 'monthly',
          maxSpendUsd: 0.01, onLimitReached: 'block' },
      ],
    }, PRICING)
    const a = scorer.score([rec({ timestamp: 3 }), rec({ timestamp: 1 }), rec({ timestamp: 2 })])
    const scorer2 = new ReplayScorer({
      budgets: [
        { id: 'tiny', scope: { type: 'org', orgId: 'acme' }, window: 'monthly',
          maxSpendUsd: 0.01, onLimitReached: 'block' },
      ],
    }, PRICING)
    const b = scorer2.score([rec({ timestamp: 1 }), rec({ timestamp: 2 }), rec({ timestamp: 3 })])
    expect(a.blocks).toBe(b.blocks)
    expect(a.candidateCostUsd).toBeCloseTo(b.candidateCostUsd, 6)
  })
})

// ── Parity with live FinRouter ────────────────────────────────────────────
//
// We don't replay end-to-end against a live router (that would require mock
// providers and a full chat() loop). Instead, we exercise the same code paths
// (RulesEngine + CostRouter + PolicyEngine) directly and confirm that the
// scorer's outputs match independent reasoning. The components themselves are
// covered by `rules-engine.test.ts`, `cost-router.test.ts`,
// `router-finops.test.ts`. This file verifies that the scorer's *composition*
// of those components produces the same decisions as `router.applyRuleAndCost`
// + `policyEngine.evaluate`.

describe('ReplayScorer — composition matches FinRouter.applyRuleAndCost', () => {
  it('rule pin under pin-wins mode bypasses cost router', () => {
    const scorer = new ReplayScorer({
      rules: {
        rules: [{ id: 'pin', action: { type: 'pin', model: 'gemini-2.0-flash' }, match: {} }],
        mode: 'pin-wins',
      },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['gemini-2.0-flash-lite'],  // would be cheaper if cost router ran
      },
    }, PRICING)
    const decision = scorer.scoreOne(rec())
    expect(decision.effectiveModel).toBe('gemini-2.0-flash')
    expect(decision.ruleId).toBe('pin')
  })

  it('strategy rule overrides global cost strategy', () => {
    const scorer = new ReplayScorer({
      rules: {
        rules: [{ id: 'perf', action: { type: 'strategy', strategy: 'performance' }, match: {} }],
        mode: 'pin-wins',
      },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['gpt-4o-mini'],
      },
    }, PRICING)
    const decision = scorer.scoreOne(rec())
    expect(decision.effectiveModel).toBe('gpt-4o')  // performance strategy is a no-op
  })
})
