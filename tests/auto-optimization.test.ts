import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { simhash64, hammingDistance } from '../src/optimization/simhash.js'

describe('simhash64', () => {
  it('is stable across whitespace and case differences', () => {
    const a = simhash64('Refactor this function to be async')
    const b = simhash64('refactor   this FUNCTION to be async')
    expect(a).toBe(b)
  })

  it('produces a 16-char zero-padded hex string', () => {
    const h = simhash64('hello world')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns a stable sentinel for empty input', () => {
    expect(simhash64('   ')).toBe('0000000000000000')
  })
})

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0)
  })

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000003')).toBe(2)
  })

  it('near-duplicate text is within a small distance', () => {
    const a = simhash64('summarize the quarterly earnings report for acme corp')
    const b = simhash64('summarize the quarterly earnings report for acme corporation')
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(8)
  })
})

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FingerprintStore, type CandidateEntry } from '../src/optimization/fingerprint-store.js'

describe('FingerprintStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-fp-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('persists and reloads the candidate index', () => {
    const path = join(dir, 'candidates.json')
    const store = new FingerprintStore({ candidatesPath: path, referencesDir: join(dir, 'refs'), captureReferences: false })
    const entry: CandidateEntry = {
      fingerprint: 'eh:gpt-4o:abc', simhash: '00000000000000ab', model: 'gpt-4o',
      count: 3, totalCostUsd: 0.12, lastSeen: 1, estPredictedSavingsUsd: 0.04,
      estBreakEvenReqs: 5, sampleClassSignature: 'eh:gpt-4o:abc', status: 'observed',
    }
    store.upsert(entry)
    store.persist()
    const reloaded = new FingerprintStore({ candidatesPath: path, referencesDir: join(dir, 'refs'), captureReferences: false })
    reloaded.load()
    expect(reloaded.get('eh:gpt-4o:abc')?.count).toBe(3)
  })

  it('caps reference capture per fingerprint and honors the opt-in flag', () => {
    const refsDir = join(dir, 'refs')
    const store = new FingerprintStore({
      candidatesPath: join(dir, 'candidates.json'), referencesDir: refsDir,
      captureReferences: true, maxReferencesPerFingerprint: 2,
    })
    const sig = 'eh:gpt-4o:abc'
    for (let i = 0; i < 5; i++) {
      store.captureReference(sig, [{ role: 'user', content: `q${i}` }], `a${i}`)
    }
    const safe = sig.replace(/[/:]/g, '_')
    const lines = readFileSync(join(refsDir, `${safe}.jsonl`), 'utf-8').trim().split('\n')
    expect(lines.length).toBe(2)
  })

  it('does not write references when capture is disabled', () => {
    const refsDir = join(dir, 'refs')
    const store = new FingerprintStore({
      candidatesPath: join(dir, 'candidates.json'), referencesDir: refsDir, captureReferences: false,
    })
    store.captureReference('eh:gpt-4o:abc', [{ role: 'user', content: 'q' }], 'a')
    expect(existsSync(refsDir) && readdirSync(refsDir).length > 0).toBe(false)
  })
})

import { writeFileSync as wf, mkdirSync as mkd, utimesSync } from 'node:fs'
import { OptimizedStore, type OptimizedEntry } from '../src/optimization/optimized-store.js'
import type { ChatRequest } from '../src/types.js'

describe('OptimizedStore / FingerprintMatcher', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-opt-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const writeStore = (entries: OptimizedEntry[]): string => {
    const path = join(dir, 'optimized-prompts.json')
    mkd(dir, { recursive: true })
    wf(path, JSON.stringify(entries), 'utf-8')
    return path
  }

  const req = (content: string): ChatRequest => ({ model: 'gpt-4o', messages: [{ role: 'user', content }] })

  it('matches an exact-fingerprint request and returns the template', () => {
    const text = 'summarize the quarterly earnings report for acme corp'
    const sh = simhash64(text)
    const path = writeStore([{ fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'TPL', qualityScore: 0.9, predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1 }])
    const store = new OptimizedStore({ optimizedStorePath: path, matchHammingDistance: 3 })
    store.load()
    const m = store.match(req(text))
    expect(m?.template).toBe('TPL')
    expect(m?.targetModel).toBe('gpt-4o-mini')
  })

  it('matches a near-duplicate within the Hamming threshold', () => {
    const sh = simhash64('summarize the quarterly earnings report for acme corp')
    const path = writeStore([{ fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'TPL', qualityScore: 0.9, predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1 }])
    const store = new OptimizedStore({ optimizedStorePath: path, matchHammingDistance: 12 })
    store.load()
    expect(store.match(req('summarize the quarterly earnings report for acme corporation'))?.template).toBe('TPL')
  })

  it('does not match a dissimilar request', () => {
    const sh = simhash64('summarize the quarterly earnings report for acme corp')
    const path = writeStore([{ fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'TPL', qualityScore: 0.9, predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1 }])
    const store = new OptimizedStore({ optimizedStorePath: path, matchHammingDistance: 3 })
    store.load()
    expect(store.match(req('write a haiku about the ocean and the moon tonight'))).toBeUndefined()
  })

  it('returns undefined when the store file is missing or malformed', () => {
    const store = new OptimizedStore({ optimizedStorePath: join(dir, 'nope.json'), matchHammingDistance: 3 })
    store.load()
    expect(store.match(req('anything at all'))).toBeUndefined()
  })

  it('retries a malformed store file after it becomes valid (mtime not cached on parse error)', () => {
    const path = join(dir, 'optimized-prompts.json')
    mkd(dir, { recursive: true })
    const fixedTime = new Date('2020-01-01T00:00:00Z')
    wf(path, '{ this is not json', 'utf-8')
    utimesSync(path, fixedTime, fixedTime)
    const store = new OptimizedStore({ optimizedStorePath: path, matchHammingDistance: 3 })
    store.load()
    const text = 'summarize the quarterly earnings report for acme corp'
    const sh = simhash64(text)
    wf(path, JSON.stringify([{ fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'TPL', qualityScore: 0.9, predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1 }]), 'utf-8')
    // Pin the valid file to the SAME mtime as the malformed one, so a buggy
    // implementation that cached mtime before parsing would skip this reload.
    utimesSync(path, fixedTime, fixedTime)
    store.reloadIfChanged()
    expect(store.match({ model: 'gpt-4o', messages: [{ role: 'user', content: text }] })?.template).toBe('TPL')
  })
})

import { validateConfigKeys } from '../src/config-loader.js'

describe('autoOptimization config', () => {
  it('is an accepted top-level config key', () => {
    expect(validateConfigKeys({ autoOptimization: { enabled: true } })).toEqual([])
  })
})

import { CandidateDetector } from '../src/optimization/candidate-detector.js'
import type { SpendRecord } from '../src/types.js'

describe('CandidateDetector', () => {
  const cfg = {
    targetInputPer1M: 0.5,
    costlyModelInputPer1M: 5,
    minObservations: 3,
    optimizationCostUsdEstimate: 0.5,
    modelInputRates: { 'gpt-4o': 10, 'gpt-4o-mini': 0.5 },
  }

  const rec = (model: string, fp: string, tokens: number): { record: SpendRecord; simhash: string; fingerprint: string } => ({
    record: {
      userId: 'u', provider: 'openai', model,
      tokens: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
      costUsd: 0.01, timestamp: Date.now(),
    },
    simhash: fp.slice(-16).padStart(16, '0'),
    fingerprint: fp,
  })

  it('qualifies a frequent costly-model fingerprint and estimates savings', () => {
    const d = new CandidateDetector(cfg)
    for (let i = 0; i < 4; i++) d.observe(rec('gpt-4o', 'eh:gpt-4o:00000000000000ab', 100000))
    const candidates = d.computeCandidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.model).toBe('gpt-4o')
    expect(candidates[0]!.count).toBe(4)
    expect(candidates[0]!.estPredictedSavingsUsd).toBeGreaterThan(0)
    expect(candidates[0]!.status).toBe('observed')
  })

  it('ignores cheap-model traffic', () => {
    const d = new CandidateDetector(cfg)
    for (let i = 0; i < 10; i++) d.observe(rec('gpt-4o-mini', 'eh:gpt-4o-mini:00000000000000cd', 100000))
    expect(d.computeCandidates()).toHaveLength(0)
  })

  it('ignores costly fingerprints below minObservations', () => {
    const d = new CandidateDetector(cfg)
    d.observe(rec('gpt-4o', 'eh:gpt-4o:00000000000000ab', 100000))
    d.observe(rec('gpt-4o', 'eh:gpt-4o:00000000000000ab', 100000))
    expect(d.computeCandidates()).toHaveLength(0)
  })

  it('ranks candidates by predicted savings descending', () => {
    const d = new CandidateDetector(cfg)
    for (let i = 0; i < 3; i++) d.observe(rec('gpt-4o', 'eh:gpt-4o:00000000000000ab', 50000))
    for (let i = 0; i < 3; i++) d.observe(rec('gpt-4o', 'eh:gpt-4o:00000000000000ef', 200000))
    const c = d.computeCandidates()
    expect(c).toHaveLength(2)
    expect(c[0]!.estPredictedSavingsUsd).toBeGreaterThanOrEqual(c[1]!.estPredictedSavingsUsd)
  })
})

import { FreeRouter } from '../src/router.js'
import type { BaseProvider } from '../src/providers/base-provider.js'

class FakeProvider {
  name = 'openai'
  async chat(req: ChatRequest): Promise<any> {
    return {
      id: 'x', model: req.model, content: `system=${req.messages.find(m => m.role === 'system')?.content ?? 'none'}`,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1, provider: 'openai', finishedAt: Date.now(),
    }
  }
  async *chatStream(): AsyncGenerator<any> { /* unused */ }
  pricing(_model: string) { return { input: 2.5, output: 10 } }
}

describe('FreeRouter auto-optimization injection', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-router-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('injects an optimized template for a matching prompt and routes to target', async () => {
    const text = 'summarize the quarterly earnings report for acme corp in detail'
    const sh = simhash64(text)
    const storePath = join(dir, 'optimized-prompts.json')
    wf(storePath, JSON.stringify([{
      fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'OPTIMIZED', qualityScore: 0.9,
      predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1,
    }]), 'utf-8')

    const router = new FreeRouter({
      autoOptimization: {
        enabled: true, candidatesPath: join(dir, 'candidates.json'),
        optimizedStorePath: storePath, referencesDir: join(dir, 'refs'),
        targetModel: 'gpt-4o-mini', captureReferences: false,
      },
    })
    router.registerProvider(new FakeProvider() as unknown as BaseProvider)
    router.setKey('user1', 'openai', 'sk-test')

    const resp = await router.chat('user1', { model: 'gpt-4o', messages: [{ role: 'user', content: text }] })
    expect(resp.model).toBe('gpt-4o-mini')
    expect(resp.content).toContain('OPTIMIZED')
  })

  it('does not inject for a dissimilar prompt', async () => {
    const sh = simhash64('summarize the quarterly earnings report for acme corp in detail')
    const storePath = join(dir, 'optimized-prompts.json')
    wf(storePath, JSON.stringify([{
      fingerprint: `eh:gpt-4o:${sh}`, simhash: sh, template: 'OPTIMIZED', qualityScore: 0.9,
      predictedSavingsUsd: 0.1, targetModel: 'gpt-4o-mini', optimizedAt: 1,
    }]), 'utf-8')
    const router = new FreeRouter({
      autoOptimization: {
        enabled: true, candidatesPath: join(dir, 'candidates.json'),
        optimizedStorePath: storePath, referencesDir: join(dir, 'refs'),
        targetModel: 'gpt-4o-mini', captureReferences: false,
      },
    })
    router.registerProvider(new FakeProvider() as unknown as BaseProvider)
    router.setKey('user1', 'openai', 'sk-test')
    const resp = await router.chat('user1', { model: 'gpt-4o', messages: [{ role: 'user', content: 'write a haiku about the ocean tonight' }] })
    expect(resp.model).toBe('gpt-4o')
    expect(resp.content).toContain('none')
  })
})
