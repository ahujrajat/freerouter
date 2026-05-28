import { describe, it, expect } from 'vitest'
import { extractFeatures, score, DEFAULT_WEIGHTS } from '../src/optimization/complexity-heuristics.js'
import { RequestClassifier } from '../src/optimization/classifier.js'
import { PromptCache } from '../src/optimization/prompt-cache.js'
import { OptimizationLedger } from '../src/optimization/ledger.js'
import { ComplexityGate } from '../src/optimization/complexity-gate.js'
import { GepaBridge, type OptimizeResponse } from '../src/optimization/gepa-bridge.js'
import { OptimizationPipeline } from '../src/optimization/pipeline.js'
import type { ChatRequest, RequestContext } from '../src/types.js'

// ── Complexity heuristics ──────────────────────────────────────────────────

describe('complexity-heuristics', () => {
  it('scores a trivial question as low complexity', () => {
    const features = extractFeatures([{ role: 'user', content: 'What is the capital of France?' }])
    const s = score(features)
    expect(s.score).toBeLessThan(0.25)
  })

  it('scores a code+reasoning+format prompt higher than a trivial one', () => {
    const trivial = score(extractFeatures([{ role: 'user', content: 'capital of France?' }]))
    const complex = score(extractFeatures([{
      role: 'user',
      content: `Refactor this Python function to be async, then explain why each
                change matters step-by-step. Output as JSON with keys
                original, refactored, rationale.

                \`\`\`python
                def fetch(url):
                    return requests.get(url).json()
                \`\`\`

                Constraints: must not change the public API, do not introduce new
                dependencies, must handle exceptions gracefully.`,
    }]))
    expect(complex.score).toBeGreaterThan(trivial.score * 3)
    expect(complex.features.reasoningMarkers).toBeGreaterThan(0)
    expect(complex.features.codeBlocks).toBeGreaterThanOrEqual(1)
    expect(complex.features.formatConstraints).toBeGreaterThanOrEqual(1)
    expect(complex.features.constraintWords).toBeGreaterThanOrEqual(2)
  })

  it('rejects pathological weights gracefully (score is bounded 0-1)', () => {
    const features = extractFeatures([{ role: 'user', content: 'hello' }])
    const big = { ...DEFAULT_WEIGHTS, tokens: 1e6 }
    const s = score(features, big)
    expect(s.score).toBeLessThanOrEqual(1)
    expect(s.score).toBeGreaterThanOrEqual(0)
  })
})

// ── RequestClassifier ──────────────────────────────────────────────────────

describe('RequestClassifier', () => {
  const ctx: RequestContext = { orgId: 'acme' }

  it('metadata strategy reads from request.metadata[taskClass]', () => {
    const c = new RequestClassifier({ strategy: 'metadata' })
    const result = c.classify(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], metadata: { taskClass: 'summarize-article' } },
      ctx,
    )
    expect(result.signature).toBe('md:summarize-article')
  })

  it('rule-based bucketizes by length / code / format', () => {
    const c = new RequestClassifier({ strategy: 'rule-based' })
    const short = c.classify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }, ctx)
    const long  = c.classify({ model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'a'.repeat(5000) + '```code```' + ' in json' }],
    }, ctx)
    expect(short.signature).not.toBe(long.signature)
    expect(long.signature).toContain('code')
    expect(long.signature).toContain('fmt')
  })

  it('embed-hash produces a stable 64-bit signature', () => {
    const c = new RequestClassifier({ strategy: 'embed-hash' })
    const req: ChatRequest = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'analyze the weather impact on logistics' }] }
    const a = c.classify(req, ctx)
    const b = c.classify(req, ctx)
    expect(a.signature).toBe(b.signature)
    expect(a.signature).toMatch(/^eh:gpt-4o-mini:[0-9a-f]{16}$/)
  })
})

// ── PromptCache ────────────────────────────────────────────────────────────

describe('PromptCache', () => {
  const key = (orgId: string, sig = 'cls1') => ({
    classSignature: sig, targetModel: 'gpt-4o-mini', scope: 'org' as const, orgId, userId: 'u1',
  })

  it('round-trips a template within TTL', () => {
    const cache = new PromptCache()
    cache.set(key('acme'), { template: 'optimized prompt' })
    expect(cache.get(key('acme'))?.template).toBe('optimized prompt')
  })

  it('scopes by tenant: org A and org B do not collide', () => {
    const cache = new PromptCache()
    cache.set(key('a'), { template: 'A' })
    cache.set(key('b'), { template: 'B' })
    expect(cache.get(key('a'))?.template).toBe('A')
    expect(cache.get(key('b'))?.template).toBe('B')
  })

  it('expires after TTL', () => {
    const cache = new PromptCache({ ttlMs: 1 })
    cache.set(key('acme'), { template: 'x' })
    return new Promise<void>(resolve => setTimeout(() => {
      expect(cache.get(key('acme'))).toBeUndefined()
      resolve()
    }, 10))
  })

  it('evicts oldest when over maxEntries', () => {
    const cache = new PromptCache({ maxEntries: 2 })
    cache.set(key('o1', 's1'), { template: '1' })
    cache.set(key('o1', 's2'), { template: '2' })
    cache.set(key('o1', 's3'), { template: '3' })
    expect(cache.size).toBe(2)
    expect(cache.get(key('o1', 's1'))).toBeUndefined()
    expect(cache.get(key('o1', 's3'))?.template).toBe('3')
  })
})

// ── OptimizationLedger ─────────────────────────────────────────────────────

describe('OptimizationLedger', () => {
  const scope = { scope: 'org' as const, orgId: 'acme' }
  it('records optimization cost and per-request savings', () => {
    const ledger = new OptimizationLedger()
    ledger.recordOptimization({
      classSignature: 'c1', scope, targetModel: 'm', fallbackModel: 'f',
      optimizationUsd: 1, qualityScore: 0.9,
    })
    ledger.recordRequest({ classSignature: 'c1', scope, actualCostUsd: 0.01, fallbackCostUsd: 0.05 })
    const snap = ledger.snapshot()
    expect(snap[0]?.realizedSavingsUsd).toBeCloseTo(0.04, 5)
    expect(snap[0]?.optimizationUsd).toBe(1)
  })

  it('disables classes whose ROI < 1 after minObservationRequests', () => {
    const ledger = new OptimizationLedger({ minObservationRequests: 3, cooldownMs: 60_000 })
    ledger.recordOptimization({
      classSignature: 'c1', scope, targetModel: 'm', fallbackModel: 'f',
      optimizationUsd: 5, qualityScore: 0.9,
    })
    for (let i = 0; i < 3; i++) {
      ledger.recordRequest({ classSignature: 'c1', scope, actualCostUsd: 0.01, fallbackCostUsd: 0.01 })
    }
    expect(ledger.isDisabled('c1', scope)).toBe(true)
    expect(ledger.classPrior('c1', scope)).toBe(0)
  })

  it('returns a neutral prior for unseen classes', () => {
    const ledger = new OptimizationLedger()
    expect(ledger.classPrior('unseen', scope)).toBe(1)
  })
})

// ── ComplexityGate ─────────────────────────────────────────────────────────

describe('ComplexityGate', () => {
  const classifier = new RequestClassifier({ strategy: 'rule-based' })
  const ledger = new OptimizationLedger()
  const gate = new ComplexityGate(classifier, ledger, {
    targetInputPer1M: 0.15,
    fallbackInputPer1M: 2.50,
    minRoiUsd: 0.002,
    defaultExpectedReuse: 100,
  })

  it('routes trivial requests to direct-target', () => {
    const d = gate.evaluate(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { orgId: 'acme' }, 'u1',
    )
    expect(d.action).toBe('direct-target')
  })

  it('routes complex high-token requests to optimize', () => {
    const longContent = 'analyze step by step why this code fails: ' + 'a'.repeat(3000)
      + '\n```js\nfunction broken() { throw 1 }\n``` respond as json'
    const d = gate.evaluate(
      { model: 'gpt-4o', messages: [{ role: 'user', content: longContent }] },
      { orgId: 'acme' }, 'u1',
    )
    expect(d.action).toBe('optimize')
    expect(d.expectedRoiUsd).toBeGreaterThan(0.002)
  })

  it('respects ledger disable flag → direct-target with rationale', () => {
    const localLedger = new OptimizationLedger({ minObservationRequests: 1, cooldownMs: 60_000 })
    localLedger.recordOptimization({
      classSignature: 'rb:gpt-4o-mini:xs:nocode:nofmt', scope: { scope: 'org', orgId: 'acme' },
      targetModel: 'gpt-4o-mini', fallbackModel: 'gpt-4o', optimizationUsd: 10, qualityScore: 0.5,
    })
    localLedger.recordRequest({
      classSignature: 'rb:gpt-4o-mini:xs:nocode:nofmt', scope: { scope: 'org', orgId: 'acme' },
      actualCostUsd: 0.01, fallbackCostUsd: 0.01,
    })
    const localGate = new ComplexityGate(classifier, localLedger, {
      targetInputPer1M: 0.15, fallbackInputPer1M: 2.50,
    })
    const d = localGate.evaluate(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { orgId: 'acme' }, 'u1',
    )
    expect(d.action).toBe('direct-target')
    expect(d.rationale).toContain('optimization_disabled')
  })
})

// ── GepaBridge with mocked fetch ──────────────────────────────────────────

describe('GepaBridge', () => {
  it('maps a 200 response into a BridgeResult', async () => {
    const body: OptimizeResponse = {
      template: 'You are an expert. Be concise.',
      qualityScore: 0.92,
      optimizationUsd: 0.45,
      predictedSavingsUsd: 0.001,
      breakEvenRequests: 50,
    }
    const fetchMock = async () => new Response(JSON.stringify(body), { status: 200 })
    const bridge = new GepaBridge({ sidecarUrl: 'http://sidecar', fetch: fetchMock as typeof fetch })
    const result = await bridge.optimize({
      classSignature: 'c1', targetModel: 'gpt-4o-mini', fallbackModel: 'gpt-4o',
      sample: { messages: [{ role: 'user', content: 'x' }], model: 'gpt-4o' },
    })
    expect(result.status).toBe('ok')
    expect(result.template?.template).toContain('expert')
    expect(result.qualityScore).toBe(0.92)
  })

  it('maps 408 → timeout, 422 → quality-gate-failed, 402 → budget-exceeded', async () => {
    const cases: Array<[number, string]> = [
      [408, 'timeout'], [422, 'quality-gate-failed'], [402, 'budget-exceeded'],
    ]
    for (const [status, expected] of cases) {
      const fetchMock = async () => new Response('', { status })
      const bridge = new GepaBridge({ sidecarUrl: 'http://x', fetch: fetchMock as typeof fetch })
      const r = await bridge.optimize({
        classSignature: 'c', targetModel: 't', fallbackModel: 'f',
        sample: { messages: [{ role: 'user', content: 'x' }], model: 't' },
      })
      expect(r.status).toBe(expected)
    }
  })

  it('treats network errors as sidecar-unreachable', async () => {
    const fetchMock = async () => { throw new Error('ECONNREFUSED') }
    const bridge = new GepaBridge({ sidecarUrl: 'http://x', fetch: fetchMock as typeof fetch })
    const r = await bridge.optimize({
      classSignature: 'c', targetModel: 't', fallbackModel: 'f',
      sample: { messages: [{ role: 'user', content: 'x' }], model: 't' },
    })
    expect(r.status).toBe('sidecar-unreachable')
  })
})

// ── OptimizationPipeline end-to-end (with mocked sidecar) ─────────────────

describe('OptimizationPipeline', () => {
  const pricingResponse: OptimizeResponse = {
    template: 'Be terse.',
    qualityScore: 0.9,
    optimizationUsd: 0.10,
    predictedSavingsUsd: 0.001,
    breakEvenRequests: 100,
  }

  function buildPipeline(fetchMock: typeof fetch) {
    return new OptimizationPipeline({
      enabled: true,
      mode: 'template-cached',
      targetModel: 'gpt-4o-mini',
      fallbackModel: 'gpt-4o',
      bridge: { sidecarUrl: 'http://sidecar', fetch: fetchMock },
      gate: {
        targetInputPer1M: 0.15,
        fallbackInputPer1M: 2.50,
        minRoiUsd: 0.002,
        defaultExpectedReuse: 100,
      },
    })
  }

  it('cache hit skips sidecar', async () => {
    let calls = 0
    const fetchMock = async () => {
      calls++
      return new Response(JSON.stringify(pricingResponse), { status: 200 })
    }
    const p = buildPipeline(fetchMock as typeof fetch)
    const req: ChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'step-by-step analyze why ' + 'a'.repeat(3000) + ' in json' }],
    }
    const ctx: RequestContext = { orgId: 'acme' }
    const r1 = await p.apply(req, ctx, 'u1')
    expect(r1.gate.action).toBe('optimize')
    expect(r1.triggeredOptimization).toBe(true)
    expect(r1.systemPrompt).toBe('Be terse.')
    const r2 = await p.apply(req, ctx, 'u1')
    expect(r2.triggeredOptimization).toBe(false)  // cache hit
    expect(calls).toBe(1)
  })

  it('failClosed routes to fallback model when sidecar errors', async () => {
    const fetchMock = async () => new Response('', { status: 500 })
    const p = buildPipeline(fetchMock as typeof fetch)
    const req: ChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'analyze step by step ' + 'b'.repeat(3000) + ' as json' }],
    }
    const r = await p.apply(req, { orgId: 'acme' }, 'u1')
    expect(r.model).toBe('gpt-4o')   // fallback, not target
    expect(r.optimizationStatus).toBe('sidecar-unreachable')
  })

  it('injectSystemPrompt prepends to existing system message', () => {
    const p = buildPipeline((async () => new Response('', { status: 200 })) as typeof fetch)
    const req: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 'original' },
        { role: 'user', content: 'hi' },
      ],
    }
    const out = p.injectSystemPrompt(req, 'BE NICE')
    expect(out.messages[0]?.role).toBe('system')
    expect(out.messages[0]?.content).toMatch(/BE NICE[\s\S]*original/)
  })

  it('apply returns direct-target when disabled', async () => {
    const p = new OptimizationPipeline({
      enabled: false,
      mode: 'off',
      targetModel: 'gpt-4o-mini',
      fallbackModel: 'gpt-4o',
      bridge: { sidecarUrl: 'http://x' },
      gate: { targetInputPer1M: 0.15, fallbackInputPer1M: 2.50 },
    })
    const r = await p.apply(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] },
      { orgId: 'acme' }, 'u1',
    )
    expect(r.gate.action).toBe('direct-target')
    expect(r.triggeredOptimization).toBe(false)
  })
})
