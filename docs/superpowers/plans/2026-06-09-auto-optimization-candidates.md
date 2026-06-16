# Auto-Optimization Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively detect prompts that frequently run on costly models, surface them as ROI-ranked optimization candidates in the config-manager GUI, and auto-inject the resulting optimized templates for same/similar prompts via fuzzy fingerprint matching — leaving the existing flag-based per-request GEPA path untouched.

**Architecture:** A passive observer in the router aggregates `SpendRecord`s by a reusable SimHash fingerprint, runs the existing complexity-gate ROI math, and writes a lightweight `candidates.json`. The config-manager GUI reads that file, lets the user select candidates, and calls the GEPA sidecar `/optimize` over HTTP (references already captured to the sidecar's `references_dir`), writing results to `optimized-prompts.json`. At request time the router matches incoming prompts against that store by Hamming distance and injects the optimized template, routing to the cheap target model. All three files are the shared contract; no live inter-process link.

**Tech Stack:** TypeScript (router, stores, detector — Vitest tests, ESM `.js` import specifiers), Python 3 + Tkinter (config-manager GUI), existing FastAPI GEPA sidecar (unchanged).

---

## File Structure

**New (TypeScript):**
- `src/optimization/simhash.ts` — reusable 64-bit SimHash + Hamming distance. Extracted from `classifier.ts`.
- `src/optimization/fingerprint-store.ts` — candidate index load/persist + capped reference capture.
- `src/optimization/candidate-detector.ts` — aggregate `SpendRecord`s → ROI-ranked candidates.
- `src/optimization/optimized-store.ts` — load/watch `optimized-prompts.json`; `FingerprintMatcher`.

**Modified (TypeScript):**
- `src/optimization/classifier.ts` — use the extracted SimHash util (no behavior change).
- `src/config.ts` — add `AutoOptimizationConfig` + field on `RouterConfig`.
- `src/config-loader.ts` — add `autoOptimization` to `KNOWN_KEYS`.
- `src/router.ts` — instantiate auto-optimization, capture after response, match+inject before dispatch.
- `src/index.ts` — export new public types/classes.

**New tests:**
- `tests/auto-optimization.test.ts` — simhash, fingerprint-store, detector, optimized-store/matcher units + router integration.

**Modified (Python):**
- `config-manager/app.py` — new "Candidates" sub-panel in the Optimization tab.
- `config-manager/candidates_io.py` — read candidates / write optimized store / call sidecar (new module).

---

## Task 1: Extract reusable SimHash utility

**Files:**
- Create: `src/optimization/simhash.ts`
- Test: `tests/auto-optimization.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/auto-optimization.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts`
Expected: FAIL — cannot find module `../src/optimization/simhash.js`.

- [ ] **Step 3: Write the implementation**

Create `src/optimization/simhash.ts`. This is the SimHash logic lifted verbatim from `classifier.ts::classifyByHash` plus a Hamming helper:

```ts
import { createHash } from 'node:crypto'

/** Returns the SHA-256 of `s` as two 32-bit halves [lo, hi] of the first 64 bits. */
function sha256u64(s: string): [number, number] {
  const h = createHash('sha256').update(s).digest()
  return [h.readUInt32LE(0), h.readUInt32LE(4)]
}

/**
 * SimHash-like 64-bit fingerprint over normalized text. Stable across
 * whitespace, case, and minor edits; sensitive to topical content.
 * Returns a 16-char zero-padded lowercase hex string.
 */
export function simhash64(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (tokens.length === 0) return '0000000000000000'
  const bits = new Int32Array(64)
  for (const tok of tokens) {
    const h = sha256u64(tok)
    for (let i = 0; i < 64; i++) {
      const bit = (h[i < 32 ? 0 : 1]! >> (i % 32)) & 1
      bits[i]! += bit === 1 ? 1 : -1
    }
  }
  let lo = 0, hi = 0
  for (let i = 0; i < 32; i++) if (bits[i]! > 0) lo |= 1 << i
  for (let i = 32; i < 64; i++) if (bits[i]! > 0) hi |= 1 << (i - 32)
  const sig = (BigInt.asUintN(32, BigInt(hi >>> 0)) << 32n) | BigInt.asUintN(32, BigInt(lo >>> 0))
  return sig.toString(16).padStart(16, '0')
}

/** Number of differing bits between two 16-char hex SimHash strings. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts`
Expected: PASS (6 assertions in the two describe blocks).

- [ ] **Step 5: Refactor classifier to use the util (no behavior change)**

In `src/optimization/classifier.ts`, replace the body of `classifyByHash` and delete the local `sha256u64`. Add the import at the top:

```ts
import { simhash64 } from './simhash.js'
```

Replace the entire `private classifyByHash(req: ChatRequest): RequestClass { ... }` method with:

```ts
  private classifyByHash(req: ChatRequest): RequestClass {
    const text = req.messages.map(m => m.content).join(' ')
    const hash = simhash64(text)
    if (hash === '0000000000000000') {
      return { signature: `eh:${req.model}:empty` }
    }
    return { signature: `eh:${req.model}:${hash}` }
  }
```

Then delete the now-unused standalone `function sha256u64(...)` at the bottom of `classifier.ts`.

- [ ] **Step 6: Run the existing classifier tests to verify no regression**

Run: `npx vitest run tests/optimization.test.ts`
Expected: PASS — all existing classifier/embed-hash tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/optimization/simhash.ts src/optimization/classifier.ts tests/auto-optimization.test.ts
git commit -m "refactor: extract reusable SimHash util from classifier"
```

---

## Task 2: Fingerprint store (candidate index + capped reference capture)

**Files:**
- Create: `src/optimization/fingerprint-store.ts`
- Test: `tests/auto-optimization.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-optimization.test.ts`:

```ts
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
```

Add `beforeEach, afterEach` to the existing `vitest` import line at the top of the file:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t FingerprintStore`
Expected: FAIL — cannot find module `../src/optimization/fingerprint-store.js`.

- [ ] **Step 3: Write the implementation**

Create `src/optimization/fingerprint-store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message } from '../types.js'

export type CandidateStatus = 'observed' | 'optimizing' | 'optimized' | 'rejected'

export interface CandidateEntry {
  fingerprint: string
  simhash: string
  model: string
  count: number
  totalCostUsd: number
  lastSeen: number
  estPredictedSavingsUsd: number
  estBreakEvenReqs: number
  sampleClassSignature: string
  status: CandidateStatus
}

export interface FingerprintStoreConfig {
  candidatesPath: string
  referencesDir: string
  captureReferences: boolean
  maxReferencesPerFingerprint?: number
}

/** Persists the lightweight candidate index and captures capped references. */
export class FingerprintStore {
  private readonly index = new Map<string, CandidateEntry>()
  private readonly refCounts = new Map<string, number>()
  private readonly maxRefs: number

  constructor(private readonly cfg: FingerprintStoreConfig) {
    this.maxRefs = cfg.maxReferencesPerFingerprint ?? 10
  }

  load(): void {
    if (!existsSync(this.cfg.candidatesPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.cfg.candidatesPath, 'utf-8')) as CandidateEntry[]
      for (const e of raw) this.index.set(e.fingerprint, e)
    } catch { /* malformed → start empty */ }
  }

  get(fingerprint: string): CandidateEntry | undefined {
    return this.index.get(fingerprint)
  }

  upsert(entry: CandidateEntry): void {
    this.index.set(entry.fingerprint, entry)
  }

  all(): CandidateEntry[] {
    return [...this.index.values()]
  }

  persist(): void {
    const path = this.cfg.candidatesPath
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf-8')
    renameSync(tmp, path)
  }

  /** Append a {messages, output} reference for a fingerprint, capped per fingerprint. */
  captureReference(classSignature: string, messages: Message[], output: string): void {
    if (!this.cfg.captureReferences) return
    const used = this.refCounts.get(classSignature) ?? 0
    if (used >= this.maxRefs) return
    mkdirSync(this.cfg.referencesDir, { recursive: true })
    const safe = classSignature.replace(/[/:]/g, '_')
    const line = JSON.stringify({ messages, output })
    appendFileSync(join(this.cfg.referencesDir, `${safe}.jsonl`), line + '\n', 'utf-8')
    this.refCounts.set(classSignature, used + 1)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts -t FingerprintStore`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/optimization/fingerprint-store.ts tests/auto-optimization.test.ts
git commit -m "feat: add fingerprint store with capped reference capture"
```

---

## Task 3: Candidate detector (ROI-ranked aggregation)

**Files:**
- Create: `src/optimization/candidate-detector.ts`
- Test: `tests/auto-optimization.test.ts` (append)

**Note on ROI math:** We reuse the complexity-gate's savings formula directly:
`savingsPerRequestUsd = (avgTokens / 1_000_000) * max(0, fallbackInputPer1M - targetInputPer1M)`.
`estPredictedSavingsUsd = savingsPerRequestUsd * count`. `estBreakEvenReqs = ceil(optimizationCostUsdEstimate / savingsPerRequestUsd)`. A candidate qualifies only when its model's input rate `>= costlyModelInputPer1M`, `count >= minObservations`, and `savingsPerRequestUsd > 0`.

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-optimization.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t CandidateDetector`
Expected: FAIL — cannot find module `../src/optimization/candidate-detector.js`.

- [ ] **Step 3: Write the implementation**

Create `src/optimization/candidate-detector.ts`:

```ts
import type { SpendRecord } from '../types.js'
import type { CandidateEntry } from './fingerprint-store.js'

export interface CandidateDetectorConfig {
  /** Per-1M input price of the cheap target model. */
  targetInputPer1M: number
  /** Model input rate at/above which a model counts as "costly". */
  costlyModelInputPer1M: number
  /** Minimum observations before a fingerprint qualifies. */
  minObservations: number
  /** Flat estimate of one optimization run's USD cost, for break-even. */
  optimizationCostUsdEstimate: number
  /** Known per-model input rates (USD / 1M tokens), e.g. from the registry. */
  modelInputRates: Record<string, number>
}

interface Agg {
  fingerprint: string
  simhash: string
  model: string
  count: number
  totalCostUsd: number
  totalPromptTokens: number
  lastSeen: number
}

export interface Observation {
  record: SpendRecord
  fingerprint: string
  simhash: string
}

/** Aggregates spend observations per fingerprint and ranks optimization candidates. */
export class CandidateDetector {
  private readonly aggs = new Map<string, Agg>()

  constructor(private readonly cfg: CandidateDetectorConfig) {}

  observe(obs: Observation): void {
    const { record, fingerprint, simhash } = obs
    const existing = this.aggs.get(fingerprint)
    if (existing === undefined) {
      this.aggs.set(fingerprint, {
        fingerprint, simhash, model: record.model, count: 1,
        totalCostUsd: record.costUsd, totalPromptTokens: record.tokens.promptTokens,
        lastSeen: record.timestamp,
      })
      return
    }
    existing.count += 1
    existing.totalCostUsd += record.costUsd
    existing.totalPromptTokens += record.tokens.promptTokens
    existing.lastSeen = Math.max(existing.lastSeen, record.timestamp)
  }

  computeCandidates(): CandidateEntry[] {
    const rateSpread = (model: string): number => {
      const fallbackRate = this.cfg.modelInputRates[model] ?? 0
      return Math.max(0, fallbackRate - this.cfg.targetInputPer1M)
    }
    const out: CandidateEntry[] = []
    for (const a of this.aggs.values()) {
      const modelRate = this.cfg.modelInputRates[a.model] ?? 0
      if (modelRate < this.cfg.costlyModelInputPer1M) continue
      if (a.count < this.cfg.minObservations) continue
      const avgTokens = a.totalPromptTokens / a.count
      const savingsPerReq = (avgTokens / 1_000_000) * rateSpread(a.model)
      if (savingsPerReq <= 0) continue
      const estPredictedSavingsUsd = savingsPerReq * a.count
      const estBreakEvenReqs = Math.ceil(this.cfg.optimizationCostUsdEstimate / savingsPerReq)
      out.push({
        fingerprint: a.fingerprint, simhash: a.simhash, model: a.model,
        count: a.count, totalCostUsd: a.totalCostUsd, lastSeen: a.lastSeen,
        estPredictedSavingsUsd, estBreakEvenReqs,
        sampleClassSignature: a.fingerprint, status: 'observed',
      })
    }
    out.sort((x, y) => y.estPredictedSavingsUsd - x.estPredictedSavingsUsd)
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts -t CandidateDetector`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/optimization/candidate-detector.ts tests/auto-optimization.test.ts
git commit -m "feat: add ROI-ranked candidate detector"
```

---

## Task 4: Optimized store + fingerprint matcher

**Files:**
- Create: `src/optimization/optimized-store.ts`
- Test: `tests/auto-optimization.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-optimization.test.ts`:

```ts
import { writeFileSync as wf, mkdirSync as mkd } from 'node:fs'
import { OptimizedStore, type OptimizedEntry } from '../src/optimization/optimized-store.js'
import { simhash64 } from '../src/optimization/simhash.js'
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t FingerprintMatcher`
Expected: FAIL — cannot find module `../src/optimization/optimized-store.js`.

- [ ] **Step 3: Write the implementation**

Create `src/optimization/optimized-store.ts`:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ChatRequest } from '../types.js'
import { simhash64, hammingDistance } from './simhash.js'

export interface OptimizedEntry {
  fingerprint: string
  simhash: string
  template: string
  qualityScore: number
  predictedSavingsUsd: number
  targetModel: string
  optimizedAt: number
}

export interface OptimizedStoreConfig {
  optimizedStorePath: string
  /** Max Hamming distance for a "similar" match. Default 3. */
  matchHammingDistance?: number
}

/** Loads optimized templates and matches incoming prompts by SimHash Hamming distance. */
export class OptimizedStore {
  private entries: OptimizedEntry[] = []
  private mtimeMs = 0
  private readonly maxDistance: number

  constructor(private readonly cfg: OptimizedStoreConfig) {
    this.maxDistance = cfg.matchHammingDistance ?? 3
  }

  load(): void {
    const path = this.cfg.optimizedStorePath
    if (!existsSync(path)) { this.entries = []; return }
    try {
      this.mtimeMs = statSync(path).mtimeMs
      this.entries = JSON.parse(readFileSync(path, 'utf-8')) as OptimizedEntry[]
    } catch {
      this.entries = []
    }
  }

  /** Reload only if the file changed on disk since the last load. */
  reloadIfChanged(): void {
    const path = this.cfg.optimizedStorePath
    if (!existsSync(path)) { this.entries = []; return }
    try {
      const m = statSync(path).mtimeMs
      if (m !== this.mtimeMs) this.load()
    } catch { /* keep current entries */ }
  }

  /** Return the closest optimized template within the Hamming threshold, or undefined. */
  match(req: ChatRequest): OptimizedEntry | undefined {
    if (this.entries.length === 0) return undefined
    const target = simhash64(req.messages.map(m => m.content).join(' '))
    let best: OptimizedEntry | undefined
    let bestDist = this.maxDistance + 1
    for (const e of this.entries) {
      const d = hammingDistance(target, e.simhash)
      if (d <= this.maxDistance && d < bestDist) { best = e; bestDist = d }
    }
    return best
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts -t FingerprintMatcher`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/optimization/optimized-store.ts tests/auto-optimization.test.ts
git commit -m "feat: add optimized store with Hamming-distance matcher"
```

---

## Task 5: Config type + key validation

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config-loader.ts:148-156`
- Test: `tests/auto-optimization.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-optimization.test.ts`:

```ts
import { validateConfigKeys } from '../src/config-loader.js'

describe('autoOptimization config', () => {
  it('is an accepted top-level config key', () => {
    expect(validateConfigKeys({ autoOptimization: { enabled: true } })).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t "autoOptimization config"`
Expected: FAIL — `validateConfigKeys` returns `['autoOptimization']`.

- [ ] **Step 3: Add the config interface**

In `src/config.ts`, immediately after the `PromptOptimizationConfig` interface (ends at line 99, the closing brace before `ShadowRouterConfig`), insert:

```ts
/**
 * Proactive auto-optimization. Independent of `promptOptimization`.
 *
 * When enabled, the router passively fingerprints prompts that frequently run
 * on costly models, writes ROI-ranked candidates to `candidatesPath`, and — once
 * the config-manager GUI has optimized a candidate (writing `optimizedStorePath`)
 * — injects the optimized template for same/similar prompts and routes them to
 * `targetModel`.
 */
export interface AutoOptimizationConfig {
  enabled: boolean
  /** Where ROI-ranked candidates are written (read by the config-manager GUI). */
  candidatesPath: string
  /** Where the GUI writes optimized templates (read/watched by the router). */
  optimizedStorePath: string
  /** Reference capture dir; shared with the GEPA sidecar. */
  referencesDir: string
  /** Cheap model that matched requests are routed to. */
  targetModel: string
  /** Opt-in to storing {messages, output} samples as references. Default false. */
  captureReferences?: boolean
  /** Cap on stored references per fingerprint. Default 10. */
  maxReferencesPerFingerprint?: number
  /** Model input rate (USD/1M) at/above which a model is "costly". Default 2. */
  costlyModelInputPer1M?: number
  /** Per-1M input price of the cheap target. Default 0.5. */
  targetInputPer1M?: number
  /** Max Hamming distance for a similar match. Default 3. */
  matchHammingDistance?: number
  /** Min observations before a fingerprint qualifies. Default 20. */
  minObservations?: number
  /** Flat estimate of one optimization run's USD cost, for break-even. Default 0.5. */
  optimizationCostUsdEstimate?: number
}
```

Then add the field to `RouterConfig`. Find the `promptOptimization?:` field in `RouterConfig` (search for `promptOptimization?` after line 145) and add directly below it:

```ts
  /** Proactive auto-optimization (candidate detection + optimized-prompt injection). */
  autoOptimization?: AutoOptimizationConfig
```

- [ ] **Step 4: Add the key to KNOWN_KEYS**

In `src/config-loader.ts`, change line 155 from:

```ts
  'telemetryExport', 'shadowRouter', 'promptOptimization',
```
to:
```ts
  'telemetryExport', 'shadowRouter', 'promptOptimization', 'autoOptimization',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts -t "autoOptimization config"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config-loader.ts tests/auto-optimization.test.ts
git commit -m "feat: add autoOptimization config block"
```

---

## Task 6: Router wiring (capture after response, match+inject before dispatch)

**Files:**
- Modify: `src/router.ts` (imports ~line 38; fields ~line 58; constructor ~line 200; `chat` ~line 554-653)
- Test: `tests/auto-optimization.test.ts` (append)

**Design constraints for this task:**
- Auto-injection is gated solely by `autoOptimization.enabled`.
- When the existing per-request pipeline already produced a `systemPrompt`, do NOT also auto-inject (the explicit flag-based path wins). Auto-injection applies only when `pipelineOutcome?.systemPrompt` is undefined.
- Capture/detection runs after the response and must never throw into the request path.
- A representative fingerprint for a request is `eh:<model>:<simhash(joined message contents)>`, matching the classifier's `embed-hash` signature format. Build it locally in the router via the `simhash64` util.

- [ ] **Step 1: Write the failing integration test**

Append to `tests/auto-optimization.test.ts`. This uses a fake provider and exercises the public `FinRouter.chat` path:

```ts
import { FinRouter } from '../src/router.js'
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
}

describe('FinRouter auto-optimization injection', () => {
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

    const router = new FinRouter({
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
    const router = new FinRouter({
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
```

Confirm `registerProvider` and `setKey` are the correct public method names before relying on them:

Run: `grep -n "registerProvider\|async setKey\|setKey(" src/router.ts | head`
Expected: both methods exist. If `setKey` has a different name/signature, adjust the test calls accordingly (it stores a BYOK key for `(userId, provider)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t "auto-optimization injection"`
Expected: FAIL — `resp.model` is `gpt-4o` (no injection wired yet) in the first test.

- [ ] **Step 3: Add imports**

In `src/router.ts`, after line 38 (`import { OptimizationPipeline } ...`), add:

```ts
import { OptimizedStore } from './optimization/optimized-store.js'
import { FingerprintStore } from './optimization/fingerprint-store.js'
import { CandidateDetector } from './optimization/candidate-detector.js'
import { simhash64 } from './optimization/simhash.js'
```

- [ ] **Step 4: Add fields**

In `src/router.ts`, after line 58 (`private readonly optimizationPipeline: ...`), add:

```ts
  private readonly optimizedStore: OptimizedStore | undefined
  private readonly fingerprintStore: FingerprintStore | undefined
  private readonly candidateDetector: CandidateDetector | undefined
```

- [ ] **Step 5: Instantiate in the constructor**

In `src/router.ts`, after line 202 (the `optimizationPipeline` assignment block closes), add:

```ts
    if (config.autoOptimization?.enabled === true) {
      const ao = config.autoOptimization
      this.optimizedStore = new OptimizedStore({
        optimizedStorePath: ao.optimizedStorePath,
        ...(ao.matchHammingDistance !== undefined && { matchHammingDistance: ao.matchHammingDistance }),
      })
      this.optimizedStore.load()
      this.fingerprintStore = new FingerprintStore({
        candidatesPath: ao.candidatesPath,
        referencesDir: ao.referencesDir,
        captureReferences: ao.captureReferences ?? false,
        ...(ao.maxReferencesPerFingerprint !== undefined && { maxReferencesPerFingerprint: ao.maxReferencesPerFingerprint }),
      })
      this.fingerprintStore.load()
      this.candidateDetector = new CandidateDetector({
        targetInputPer1M: ao.targetInputPer1M ?? 0.5,
        costlyModelInputPer1M: ao.costlyModelInputPer1M ?? 2,
        minObservations: ao.minObservations ?? 20,
        optimizationCostUsdEstimate: ao.optimizationCostUsdEstimate ?? 0.5,
        modelInputRates: {},
      })
    } else {
      this.optimizedStore = undefined
      this.fingerprintStore = undefined
      this.candidateDetector = undefined
    }
```

- [ ] **Step 6: Match + inject before dispatch**

In `src/router.ts` `chat()`, replace the existing block at lines 577-586:

```ts
    let effectiveReq: ChatRequest
    if (pipelineOutcome !== undefined) {
      const withModel: ChatRequest = { ...req, model: pipelineOutcome.model }
      effectiveReq = pipelineOutcome.systemPrompt !== undefined
        ? this.optimizationPipeline!.injectSystemPrompt(withModel, pipelineOutcome.systemPrompt)
        : withModel
    } else {
      const optimizedModel = this.applyRuleAndCost(req, ruleDecision)
      effectiveReq = optimizedModel !== req.model ? { ...req, model: optimizedModel } : req
    }
```

with:

```ts
    let effectiveReq: ChatRequest
    if (pipelineOutcome !== undefined) {
      const withModel: ChatRequest = { ...req, model: pipelineOutcome.model }
      effectiveReq = pipelineOutcome.systemPrompt !== undefined
        ? this.optimizationPipeline!.injectSystemPrompt(withModel, pipelineOutcome.systemPrompt)
        : withModel
    } else {
      const optimizedModel = this.applyRuleAndCost(req, ruleDecision)
      effectiveReq = optimizedModel !== req.model ? { ...req, model: optimizedModel } : req
    }

    // Auto-optimization injection (only when the flag-based pipeline didn't already inject).
    if (this.optimizedStore !== undefined && pipelineOutcome?.systemPrompt === undefined) {
      this.optimizedStore.reloadIfChanged()
      const matched = this.optimizedStore.match(req)
      if (matched !== undefined) {
        const sys = matched.template
        const injected: ChatRequest = {
          ...effectiveReq,
          model: matched.targetModel,
          messages: this.injectSystem(effectiveReq.messages, sys),
        }
        effectiveReq = injected
      }
    }
```

- [ ] **Step 7: Add the local `injectSystem` helper**

In `src/router.ts`, add a private method to the `FinRouter` class (place it just before the `chat(` method at line 554). This mirrors `OptimizationPipeline.injectSystemPrompt` so the router doesn't depend on a pipeline instance that may be undefined:

```ts
  private injectSystem(messages: ChatRequest['messages'], systemPrompt: string): ChatRequest['messages'] {
    const out: ChatRequest['messages'] = []
    let injected = false
    for (const m of messages) {
      if (!injected && m.role === 'system') {
        out.push({ role: 'system', content: `${systemPrompt}\n\n${m.content}` })
        injected = true
      } else {
        out.push(m)
      }
    }
    if (!injected) out.unshift({ role: 'system', content: systemPrompt })
    return out
  }
```

- [ ] **Step 8: Capture observation after the response**

In `src/router.ts` `chat()`, after line 638 (`this.telemetryExporter?.capture(record)`), add:

```ts
    if (this.candidateDetector !== undefined && this.fingerprintStore !== undefined) {
      try {
        const fpModel = modelName.replace(/[^\w-]/g, '_')
        const simhash = simhash64(req.messages.map(m => m.content).join(' '))
        const fingerprint = `eh:${fpModel}:${simhash}`
        const inputRate = this.registry.getModelPricing(provider.name, modelName)?.input ?? 0
        if (inputRate > 0) this.candidateDetector.setModelRate(modelName, inputRate)
        this.candidateDetector.observe({ record, fingerprint, simhash })
        this.fingerprintStore.captureReference(fingerprint, req.messages, response.content)
        this.fingerprintStore.refreshCandidates(this.candidateDetector.computeCandidates())
      } catch { /* best-effort: never affect the request */ }
    }
```

- [ ] **Step 9: Add the two small methods the capture step depends on**

These are referenced in Step 8 and must exist.

In `src/optimization/candidate-detector.ts`, add a public method to `CandidateDetector`:

```ts
  /** Record/update a model's input rate observed at runtime (USD / 1M tokens). */
  setModelRate(model: string, inputPer1M: number): void {
    this.cfg.modelInputRates[model] = inputPer1M
  }
```

In `src/optimization/fingerprint-store.ts`, add a public method to `FingerprintStore` that merges fresh detector output into the index (preserving any non-`observed` statuses set by the GUI) and persists:

```ts
  /** Merge freshly-computed candidates into the index and persist.
   *  Preserves a prior non-'observed' status (optimizing/optimized/rejected). */
  refreshCandidates(fresh: CandidateEntry[]): void {
    for (const c of fresh) {
      const prior = this.index.get(c.fingerprint)
      this.index.set(c.fingerprint, prior !== undefined && prior.status !== 'observed'
        ? { ...c, status: prior.status }
        : c)
    }
    this.persist()
  }
```

- [ ] **Step 10: Run the integration test**

Run: `npx vitest run tests/auto-optimization.test.ts -t "auto-optimization injection"`
Expected: PASS (2 tests) — first returns `gpt-4o-mini` + `OPTIMIZED`, second returns `gpt-4o` + `none`.

- [ ] **Step 11: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/router.ts src/optimization/candidate-detector.ts src/optimization/fingerprint-store.ts tests/auto-optimization.test.ts
git commit -m "feat: wire auto-optimization capture and injection into router"
```

---

## Task 7: Public API exports

**Files:**
- Modify: `src/index.ts` (after line 108, the `OptimizationPipeline` export block)
- Test: `tests/auto-optimization.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-optimization.test.ts`:

```ts
import * as FR from '../src/index.js'

describe('public exports', () => {
  it('exports the new auto-optimization building blocks', () => {
    expect(typeof FR.CandidateDetector).toBe('function')
    expect(typeof FR.FingerprintStore).toBe('function')
    expect(typeof FR.OptimizedStore).toBe('function')
    expect(typeof FR.simhash64).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-optimization.test.ts -t "public exports"`
Expected: FAIL — `FR.CandidateDetector` is undefined.

- [ ] **Step 3: Add the exports**

In `src/index.ts`, after line 108 (`export type { PipelineOutcome } from './optimization/pipeline.js'`), add:

```ts
// Optimization — auto-optimization candidates
export { simhash64, hammingDistance } from './optimization/simhash.js'
export { CandidateDetector } from './optimization/candidate-detector.js'
export type { CandidateDetectorConfig, Observation } from './optimization/candidate-detector.js'
export { FingerprintStore } from './optimization/fingerprint-store.js'
export type { CandidateEntry, CandidateStatus, FingerprintStoreConfig } from './optimization/fingerprint-store.js'
export { OptimizedStore } from './optimization/optimized-store.js'
export type { OptimizedEntry, OptimizedStoreConfig } from './optimization/optimized-store.js'
export type { AutoOptimizationConfig } from './config.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-optimization.test.ts -t "public exports"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/auto-optimization.test.ts
git commit -m "feat: export auto-optimization public API"
```

---

## Task 8: Config-manager GUI — Candidates panel

**Files:**
- Create: `config-manager/candidates_io.py`
- Modify: `config-manager/app.py` (`_build_optimization_tab` at line 1033 — append a Candidates LabelFrame; add handler methods on `AdminApp`)
- Test: `config-manager/test_candidates_io.py`

**Note:** The config-manager uses Python stdlib only. `candidates_io.py` uses `urllib.request` for the sidecar HTTP call (same approach as `pricing_fetcher.py`). The GUI panel reads `candidates.json`, shows a Treeview, and on "Optimize Selected" calls the sidecar `/optimize` per selected candidate, writes results to `optimized-prompts.json`, and flips status.

- [ ] **Step 1: Write the failing test**

Create `config-manager/test_candidates_io.py`:

```python
import json
import os
import tempfile
import unittest

import candidates_io


class TestCandidatesIO(unittest.TestCase):
    def test_load_candidates_returns_empty_when_missing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(candidates_io.load_candidates(os.path.join(d, "nope.json")), [])

    def test_load_candidates_reads_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "candidates.json")
            with open(path, "w") as f:
                json.dump([{"fingerprint": "eh:gpt-4o:ab", "model": "gpt-4o", "count": 3,
                            "estPredictedSavingsUsd": 0.1, "status": "observed", "simhash": "00000000000000ab"}], f)
            rows = candidates_io.load_candidates(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["model"], "gpt-4o")

    def test_write_optimized_appends_and_dedupes_by_fingerprint(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "optimized-prompts.json")
            e1 = {"fingerprint": "fp1", "simhash": "1", "template": "A", "qualityScore": 0.9,
                  "predictedSavingsUsd": 0.1, "targetModel": "gpt-4o-mini", "optimizedAt": 1}
            candidates_io.write_optimized(path, e1)
            e1b = {**e1, "template": "B"}
            candidates_io.write_optimized(path, e1b)
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["template"], "B")

    def test_update_candidate_status(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "candidates.json")
            with open(path, "w") as f:
                json.dump([{"fingerprint": "fp1", "status": "observed"}], f)
            candidates_io.update_status(path, "fp1", "optimized")
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(data[0]["status"], "optimized")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd config-manager && python -m unittest test_candidates_io -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'candidates_io'`.

- [ ] **Step 3: Write `candidates_io.py`**

Create `config-manager/candidates_io.py`:

```python
"""Read auto-optimization candidates, call the GEPA sidecar to optimize them,
and write the optimized-prompt store. Stdlib only (mirrors pricing_fetcher.py).
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.request
from typing import Any


def load_candidates(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _atomic_write(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def write_optimized(path: str, entry: dict[str, Any]) -> None:
    existing = load_candidates(path)  # same list-shape loader
    by_fp = {e.get("fingerprint"): e for e in existing}
    by_fp[entry["fingerprint"]] = entry
    _atomic_write(path, list(by_fp.values()))


def update_status(candidates_path: str, fingerprint: str, status: str) -> None:
    rows = load_candidates(candidates_path)
    for r in rows:
        if r.get("fingerprint") == fingerprint:
            r["status"] = status
    _atomic_write(candidates_path, rows)


def optimize_candidate(
    sidecar_url: str,
    class_signature: str,
    target_model: str,
    fallback_model: str,
    sample_messages: list[dict[str, str]],
    auth_token: str | None = None,
    timeout: float = 120.0,
    verify_tls: bool = True,
) -> dict[str, Any]:
    """POST /optimize to the GEPA sidecar. References must already exist on
    disk in the sidecar's references_dir. Returns the OptimizeResponse dict.
    Raises RuntimeError on HTTP error."""
    body = json.dumps({
        "classSignature": class_signature,
        "targetModel": target_model,
        "fallbackModel": fallback_model,
        "sample": {"messages": sample_messages, "model": fallback_model},
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    req = urllib.request.Request(sidecar_url.rstrip("/") + "/optimize", data=body, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    if not verify_tls:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"sidecar returned HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"sidecar unreachable: {exc.reason}") from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd config-manager && python -m unittest test_candidates_io -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the Candidates panel to the Optimization tab**

In `config-manager/app.py`, at the end of `_build_optimization_tab` (after line 1199, after the `gate_rows` loop), append a new LabelFrame. Insert this code as the last lines of the method (same indentation as the `po = ttk.LabelFrame(...)` block):

```python
        # ── Auto-optimization candidates ───────────────────────────
        ac = ttk.LabelFrame(f, text="Auto-optimization candidates", padding=10)
        ac.grid(row=4, column=0, sticky="ew", pady=(12, 0))
        ac.columnconfigure(0, weight=1)

        self.ao_candidates_path_var = tk.StringVar()
        self.ao_optimized_path_var = tk.StringVar()
        self.ao_target_var = tk.StringVar()
        self.ao_fallback_var = tk.StringVar()
        for v in (self.ao_candidates_path_var, self.ao_optimized_path_var,
                  self.ao_target_var, self.ao_fallback_var):
            v.trace_add("write", self._mark_dirty)

        paths = ttk.Frame(ac)
        paths.grid(row=0, column=0, sticky="ew")
        paths.columnconfigure(1, weight=1)
        for r, (label, var) in enumerate([
            ("Candidates file (candidates.json)", self.ao_candidates_path_var),
            ("Optimized store (optimized-prompts.json)", self.ao_optimized_path_var),
            ("Target (cheap) model", self.ao_target_var),
            ("Fallback (capable) model", self.ao_fallback_var),
        ]):
            _grid_label(paths, label, r)
            _grid_entry(paths, var, r)

        self.ao_tree = ttk.Treeview(
            ac, columns=("model", "count", "savings", "status"), show="headings", height=6,
        )
        for col, head, w in [("model", "Model", 160), ("count", "Count", 70),
                             ("savings", "Est. savings (USD)", 130), ("status", "Status", 100)]:
            self.ao_tree.heading(col, text=head)
            self.ao_tree.column(col, width=w, anchor="w")
        self.ao_tree.grid(row=1, column=0, sticky="ew", pady=(8, 4))

        btns = ttk.Frame(ac)
        btns.grid(row=2, column=0, sticky="w")
        ttk.Button(btns, text="Refresh", command=self._reload_candidates).pack(side="left")
        ttk.Button(btns, text="Optimize Selected", command=self._optimize_selected).pack(side="left", padx=6)
        self.ao_status_var = tk.StringVar(value="")
        ttk.Label(ac, textvariable=self.ao_status_var, foreground="#555").grid(row=3, column=0, sticky="w", pady=(4, 0))
```

- [ ] **Step 6: Add the handler methods on `AdminApp`**

In `config-manager/app.py`, add an import near the top with the other local imports (find the line importing `pricing_fetcher` or similar and add alongside):

```python
import candidates_io
```

Then add these methods to the `AdminApp` class (place them immediately after `_build_optimization_tab`, before `_build_audit_tab` at line 1201):

```python
    def _reload_candidates(self) -> None:
        path = self.ao_candidates_path_var.get().strip()
        if not path:
            self.ao_status_var.set("Set the candidates file path first.")
            return
        self._candidate_rows = candidates_io.load_candidates(path)
        self.ao_tree.delete(*self.ao_tree.get_children())
        for r in self._candidate_rows:
            self.ao_tree.insert("", "end", iid=r.get("fingerprint", ""), values=(
                r.get("model", ""), r.get("count", 0),
                f"{r.get('estPredictedSavingsUsd', 0):.4f}", r.get("status", "observed"),
            ))
        self.ao_status_var.set(f"Loaded {len(self._candidate_rows)} candidate(s).")

    def _optimize_selected(self) -> None:
        selected = self.ao_tree.selection()
        if not selected:
            self.ao_status_var.set("Select one or more candidates first.")
            return
        sidecar = self.po_sidecar_url_var.get().strip()
        if not sidecar:
            self.ao_status_var.set("Set the Sidecar URL (Prompt optimization section) first.")
            return
        target = self.ao_target_var.get().strip() or self.po_target_var.get().strip()
        fallback = self.ao_fallback_var.get().strip() or self.po_fallback_var.get().strip()
        cand_path = self.ao_candidates_path_var.get().strip()
        opt_path = self.ao_optimized_path_var.get().strip()
        rows_by_fp = {r.get("fingerprint"): r for r in getattr(self, "_candidate_rows", [])}

        done, failed = 0, 0
        for fp in selected:
            row = rows_by_fp.get(fp)
            if row is None:
                continue
            candidates_io.update_status(cand_path, fp, "optimizing")
            try:
                result = candidates_io.optimize_candidate(
                    sidecar_url=sidecar,
                    class_signature=row.get("sampleClassSignature", fp),
                    target_model=target,
                    fallback_model=fallback,
                    sample_messages=[{"role": "user", "content": ""}],
                )
                candidates_io.write_optimized(opt_path, {
                    "fingerprint": fp,
                    "simhash": row.get("simhash", ""),
                    "template": result["template"],
                    "qualityScore": result.get("qualityScore", 0.0),
                    "predictedSavingsUsd": result.get("predictedSavingsUsd", 0.0),
                    "targetModel": target,
                    "optimizedAt": int(__import__("time").time() * 1000),
                })
                candidates_io.update_status(cand_path, fp, "optimized")
                done += 1
            except RuntimeError as exc:
                candidates_io.update_status(cand_path, fp, "observed")
                self.ao_status_var.set(f"Failed {fp[:24]}: {exc}")
                failed += 1
        self._reload_candidates()
        if failed == 0:
            self.ao_status_var.set(f"Optimized {done} candidate(s).")
```

- [ ] **Step 7: Wire load/save of the four new path vars into config I/O**

The four `ao_*_var` values map to the `autoOptimization` config block. Find where `_build_optimization_tab`'s existing vars are read from / written to config (search for `telemetry_path_var` usage in the load and save methods):

Run: `grep -n "telemetry_path_var\|po_target_var\|def _load_config\|def _populate\|def save_all\|def _collect" config-manager/app.py`

In the populate/load method (where `self.po_target_var.set(...)` etc. are called), add:

```python
        ao = (cfg.get("autoOptimization") or {})
        self.ao_candidates_path_var.set(ao.get("candidatesPath", ""))
        self.ao_optimized_path_var.set(ao.get("optimizedStorePath", ""))
        self.ao_target_var.set(ao.get("targetModel", ""))
        self.ao_fallback_var.set(ao.get("fallbackModel", ""))
```

In the collect/save method (where the `promptOptimization` dict is assembled), add an `autoOptimization` block only when a candidates path is set:

```python
        ao_candidates = self.ao_candidates_path_var.get().strip()
        if ao_candidates:
            cfg["autoOptimization"] = {
                "enabled": True,
                "candidatesPath": ao_candidates,
                "optimizedStorePath": self.ao_optimized_path_var.get().strip(),
                "referencesDir": (cfg.get("autoOptimization") or {}).get("referencesDir", "./gepa-references"),
                "targetModel": self.ao_target_var.get().strip(),
            }
```

Adjust the surrounding variable names (`cfg`, the populate method's config variable) to match what the file actually uses — verify with the grep output above before editing.

- [ ] **Step 8: Run the Python tests + import-check the GUI module**

Run: `cd config-manager && python -m unittest test_candidates_io -v && python -c "import ast; ast.parse(open('app.py').read()); print('app.py parses')"`
Expected: candidates_io tests PASS; `app.py parses`.

- [ ] **Step 9: Commit**

```bash
git add config-manager/candidates_io.py config-manager/test_candidates_io.py config-manager/app.py
git commit -m "feat: add auto-optimization candidates panel to config-manager"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire TypeScript suite**

Run: `npx vitest run`
Expected: all tests pass, including the full `tests/auto-optimization.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the Python tests**

Run: `cd config-manager && python -m unittest discover -p "test_*.py" -v`
Expected: all pass (existing + new `test_candidates_io`).

- [ ] **Step 4: Build (if the repo builds a dist)**

Run: `npm run build`
Expected: build succeeds (tsup ESM/CJS).

- [ ] **Step 5: Final commit if anything changed**

```bash
git status
# if clean, nothing to do
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** candidate detection (Task 3), fingerprint storage + capped reference capture (Task 2), ROI-ranked qualification reusing the gate's savings formula (Task 3), SimHash fuzzy matching for "same/similar" (Tasks 1+4), GUI candidate list + optimize trigger via sidecar HTTP + shared store (Task 8), router injection independent of `promptOptimization.enabled` (Task 6), config block (Task 5), exports (Task 7).
- **Privacy opt-in:** reference capture is gated by `captureReferences` (Task 2, default false in config Task 5).
- **Flag independence & precedence:** auto-injection runs only when `autoOptimization.enabled` and only when the flag-based pipeline didn't already inject (Task 6, Step 6).
- **Type consistency check:** `CandidateEntry` (Task 2) is consumed by `CandidateDetector.computeCandidates` (Task 3) and `FingerprintStore.refreshCandidates` (Task 6 Step 9); `OptimizedEntry` (Task 4) is read by the router (Task 6) and written by the GUI (Task 8) — field names match across all three (`fingerprint`, `simhash`, `template`, `qualityScore`, `predictedSavingsUsd`, `targetModel`, `optimizedAt`).
