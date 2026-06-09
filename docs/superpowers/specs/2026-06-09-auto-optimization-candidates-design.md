# Auto-Optimization Candidates — Design

Date: 2026-06-09
Status: Approved (pending spec review)

## Problem

GEPA "Optimize Anything" today is purely reactive and flag-gated: when
`promptOptimization.enabled` is true, each incoming request is classified,
gated on ROI, and (on a cache miss) optimized inline via the sidecar. There is
no way to look across historical traffic, notice that certain prompts run
frequently on expensive models, and proactively offer to optimize them.

We want a **proactive** path that:

1. Passively observes traffic and fingerprints prompts that frequently hit
   costly models.
2. Surfaces those prompts as an ROI-ranked candidate list in the config-manager
   GUI, where the user can select prompts and trigger Optimize Anything.
3. After optimization, recognizes the same or similar prompts at request time
   and injects the optimized template, routing to the cheaper target model.

The existing flag-based per-request path stays exactly as it is. This feature is
additive and independently gated.

## Goals / Non-goals

**Goals**
- Detect candidates from existing telemetry + pricing without changing the hot
  path.
- ROI-ranked candidate list, reusing the existing complexity-gate ROI math.
- GUI-driven approval and optimization trigger.
- "Same or similar" recognition at request time using fuzzy fingerprint
  matching.
- Leave `promptOptimization` (the existing flag-based engine) untouched.

**Non-goals**
- No new embedding model / vector DB dependency (we reuse the SimHash already in
  the classifier).
- No automatic optimization without user approval (the user always selects from
  the candidate list).
- No change to the existing per-request pipeline behavior.

## Key insight: candidate capture == reference capture

The GEPA sidecar `/optimize` endpoint requires reference outputs (>= 3, see
`gepa-sidecar/src/gepa_sidecar/server.py` `min_references`) from a capable model
to optimize against. Costly-model traffic already produces exactly this: when a
prompt runs on an expensive model, that model's output is the high-quality
reference GEPA needs. So observing a costly request and capturing a reference are
the same act.

## Architecture

Three persisted artifacts form the contract shared by the GUI (Python), the
sidecar (Python), and the router (TS). All are plain JSON/JSONL files following
the existing patterns (spend-store, rules source, sidecar `references_dir`), so
no live inter-process link is required.

### 1. Candidate index — `optimization/candidates.json` (written by router)

Lightweight, no raw prompt text. One entry per fingerprint:

```jsonc
{
  "fingerprint": "eh:claude-3-opus:9f3a...",   // SimHash-derived id
  "simhash": "9f3a2b1c4d5e6f70",               // 64-bit hex, for Hamming match
  "model": "claude-3-opus",
  "count": 142,
  "totalCostUsd": 0.83,
  "lastSeen": 1749470000000,
  "estPredictedSavingsUsd": 0.21,
  "estBreakEvenReqs": 9,
  "sampleClassSignature": "eh:claude-3-opus:9f3a...",
  "status": "observed"   // observed | optimizing | optimized | rejected
}
```

### 2. References — reuses sidecar `references_dir/<sig>.jsonl`

The only place full prompt text + output is stored. Router appends a **capped**
number (default <= 10) of `{messages, output}` samples per fingerprint as it
observes costly traffic. This is exactly the data the sidecar already consumes.

**Privacy:** this extends storage beyond today's HMAC-only posture. It is
**opt-in** via `autoOptimization.captureReferences` and capped via
`maxReferencesPerFingerprint`. When disabled, candidates still surface in the GUI
but the user must seed references manually (via the existing offline pipeline)
before optimization can run.

### 3. Optimized store — `optimization/optimized-prompts.json`

Written by the sidecar via the GUI; read/watched by the router. One entry per
fingerprint:

```jsonc
{
  "fingerprint": "eh:claude-3-opus:9f3a...",
  "simhash": "9f3a2b1c4d5e6f70",
  "template": "You are an expert assistant...",
  "qualityScore": 0.88,
  "predictedSavingsUsd": 0.21,
  "targetModel": "claude-3-haiku",
  "optimizedAt": 1749480000000
}
```

## Fingerprinting & matching

Reuse the classifier's existing SimHash (`embed-hash` strategy in
`src/optimization/classifier.ts`), which already yields a 64-bit signature stable
across whitespace and minor edits. A new `FingerprintMatcher` matches an incoming
request to an optimized entry by **Hamming distance <= threshold** (configurable,
default 3 bits). Distance 0 is an exact match; small distances capture "similar".

## Components

### New TS modules (`src/optimization/`)

- **`candidate-detector.ts`** — consumes `SpendRecord`s + registry pricing + the
  SimHash; aggregates per-fingerprint count/cost; runs the existing
  complexity-gate ROI math (`ComplexityGate` heuristics) to estimate savings and
  break-even; writes `candidates.json`. Runs on the telemetry flush cycle.
  Qualifies a candidate only when `count >= minObservations`, the model's input
  rate `>= costlyModelInputPer1M`, and estimated net savings `> 0`.
- **`fingerprint-store.ts`** — load/persist the candidate index; capped reference
  capture into the sidecar `references_dir`.
- **`optimized-store.ts`** — load and watch `optimized-prompts.json`; exposes
  `FingerprintMatcher.match(req) -> OptimizedTemplate | undefined` via Hamming
  distance.

### Router wiring (`src/router.ts`)

- **After a response completes** (best-effort, off the hot path, wrapped so it
  never affects the live request): if `autoOptimization.enabled`, feed the
  `SpendRecord` + request messages + response output to the detector and capped
  reference capture.
- **On request entry, before dispatch**: if `autoOptimization.enabled`, consult
  `optimizedStore.match(req)`. On a hit, inject the template via the existing
  `OptimizationPipeline.injectSystemPrompt` and route to the cheap target model.
  This path is gated solely by `autoOptimization.enabled`, independent of
  `promptOptimization.enabled`.
- Precedence: admin rules (block) still win. The auto-optimization injection sits
  alongside the existing per-request pipeline; when both are enabled, the
  existing per-request pipeline outcome takes precedence (it is the explicit
  flag-based path), and auto-injection applies only when the per-request pipeline
  did not already produce a template.

### Config-manager GUI (`config-manager/`)

New "Optimization Candidates" panel:
- Reads `candidates.json`; displays fingerprint, model, frequency, total cost,
  estimated savings, status.
- Multi-select with an "Optimize Selected" button.
- On click: calls the sidecar `/optimize` over HTTP for each selected candidate
  (references already on disk in `references_dir`), writes results to
  `optimized-prompts.json`, and flips candidate `status`
  (`optimizing` -> `optimized` / `rejected`).
- Surfaces sidecar errors inline; on failure the candidate stays `observed`.

## New config block

```ts
autoOptimization?: {
  enabled: boolean                       // default false; independent of promptOptimization.enabled
  candidatesPath: string                 // e.g. "optimization/candidates.json"
  optimizedStorePath: string             // e.g. "optimization/optimized-prompts.json"
  referencesDir: string                  // shared with the sidecar
  targetModel: string                    // cheap model to route matches to
  captureReferences: boolean             // privacy opt-in for storing samples+outputs
  maxReferencesPerFingerprint?: number   // default 10
  costlyModelInputPer1M?: number         // threshold for "costly"; default derived from pricing
  matchHammingDistance?: number          // default 3
  minObservations?: number               // default 20 before a candidate qualifies
}
```

## Error handling & safety

- All capture/detection is best-effort and wrapped so it never affects a live
  request (failures are logged, swallowed).
- Sidecar unreachable from the GUI -> surfaced in the panel; candidate stays
  `observed`.
- Optimized-store match failure or malformed file -> fall through to normal
  routing.
- Quality-gate failure in the sidecar (HTTP 422) -> candidate marked `rejected`,
  no template written.
- Reference capture respects the cap and the opt-in flag; when off, nothing
  beyond the lightweight candidate index is persisted.

## Testing

**Unit**
- `candidate-detector`: ROI ranking, qualification thresholds (count, costly
  model, positive savings).
- `FingerprintMatcher`: exact match (distance 0), near match (distance <=
  threshold), miss (distance > threshold).
- `fingerprint-store`: capped reference capture (cap enforced, opt-in honored),
  candidate index load/persist round-trip.
- `optimized-store`: load, watch/reload, malformed-file fallthrough.

**Integration**
- Synthetic telemetry stream -> candidate appears in `candidates.json` with
  expected ROI rank.
- Write an optimized entry -> router injects the template on a matching request
  and routes to the target model; ignores it on a dissimilar request.
- `autoOptimization.enabled = false` -> no candidate writes, no injection.

## Out of scope / future

- Automatic (no-approval) optimization.
- Cross-tenant candidate sharing.
- Semantic (embedding) similarity beyond SimHash Hamming distance.
