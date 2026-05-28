import { describe, it, expect } from 'vitest'
import { ShadowRouter, MemoryShadowSink } from '../src/finops/shadow-router.js'
import type { ReplayPricingMap } from '../src/finops/replay-scorer.js'
import type { ChatRequest, RequestContext, SpendRecord } from '../src/types.js'

const PRICING: ReplayPricingMap = {
  openai: {
    'gpt-4o':      { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
  },
}

const req = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hello world' }],
  ...overrides,
})

const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  orgId: 'acme',
  ...overrides,
})

describe('ShadowRouter', () => {
  it('evaluates candidate routing without affecting live decisions', async () => {
    const sink = new MemoryShadowSink()
    const shadow = new ShadowRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['gpt-4o-mini'] },
    }, PRICING)

    await shadow.observe({
      userId: 'u1',
      req: req(),
      ctx: ctx(),
      liveModel: 'gpt-4o',
      liveCostUsd: 0.0075,
      sink,
    })

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.shadowModel).toBe('gpt-4o-mini')
    expect(sink.records[0]?.liveModel).toBe('gpt-4o')
    expect(sink.records[0]?.shadowEstimatedCostUsd).toBeLessThan(sink.records[0]!.liveCostUsd)
  })

  it('shadow blocks reflect candidate rules', async () => {
    const sink = new MemoryShadowSink()
    const shadow = new ShadowRouter({
      rules: {
        rules: [{
          id: 'no-acme', match: { orgId: 'acme' },
          action: { type: 'block', reason: 'shadow blacklist' },
        }],
        mode: 'pin-wins',
      },
    }, PRICING)

    await shadow.observe({
      userId: 'u1',
      req: req(),
      ctx: ctx(),
      liveModel: 'gpt-4o',
      liveCostUsd: 0.0075,
      sink,
    })

    expect(sink.records[0]?.shadowAllowed).toBe(false)
    expect(sink.records[0]?.shadowRuleId).toBe('no-acme')
  })

  it('accumulates actual spend so shadow budgets reflect live burn', async () => {
    const sink = new MemoryShadowSink()
    const shadow = new ShadowRouter({
      budgets: [{
        id: 'tight', scope: { type: 'org', orgId: 'acme' }, window: 'monthly',
        maxSpendUsd: 0.01, onLimitReached: 'block',
      }],
    }, PRICING)

    // Two live records pushed into the shadow tracker.
    const rec = (cost: number, ts: number): SpendRecord => ({
      userId: 'u1', orgId: 'acme', provider: 'openai', model: 'gpt-4o',
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costUsd: cost, timestamp: ts,
    })
    shadow.recordActualSpend(rec(0.006, Date.now() - 100))
    shadow.recordActualSpend(rec(0.005, Date.now() - 50))

    await shadow.observe({
      userId: 'u1',
      req: req(),
      ctx: ctx(),
      liveModel: 'gpt-4o',
      liveCostUsd: 0,
      sink,
    })

    // Budget already exceeded → shadow should block.
    expect(sink.records[0]?.shadowAllowed).toBe(false)
    expect(sink.records[0]?.shadowPolicyId).toBe('tight')
  })
})
