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
