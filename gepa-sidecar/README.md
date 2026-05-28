# freerouter-gepa-sidecar

Python sidecar implementing the offline (Phase 1–5) and per-request (Phase 6–8)
GEPA optimization pipelines documented in the FreeRouter integration plan.

## Layout

```
src/gepa_sidecar/
  judge.py             — production LLM judge (Anthropic; pairwise w/ swap; prompt caching)
  validator.py         — JSON-Schema candidate validator (uses scripts/emit-config-schema.ts output)
  replay_evaluator.py  — GEPA evaluator that shells out to scripts/score-candidate.ts
  optimize_config.py   — offline driver: evolves RouterConfig from JSONL telemetry
  server.py            — FastAPI sidecar called by GepaBridge for per-request mode
```

## Install

```bash
cd gepa-sidecar
pip install -e .                                   # production
pip install -e '.[dev]'                            # + test deps
```

Set `ANTHROPIC_API_KEY` in the environment (the judge needs it; the offline
driver also relies on it when GEPA's reflection LM is Claude).

## Offline: evolve a routing config

```bash
# Emit the schema once (the validator needs it).
tsx scripts/emit-config-schema.ts

# Run the optimizer against a telemetry capture.
python -m gepa_sidecar.optimize_config \
  --seed       ./freerouter.config.json \
  --telemetry  ./telemetry/spend.jsonl \
  --pricing    ./pricing-snapshot.json \
  --out        ./freerouter.config.optimized.json \
  --budget     medium
```

`scripts/score-candidate.ts` is invoked under the hood — same TS code paths as
the live router, so parity is guaranteed.

## Online: serve the per-request sidecar

```bash
GEPA_REFS_DIR=./gepa-references \
GEPA_LEDGER_PATH=./gepa-ledger.jsonl \
ANTHROPIC_API_KEY=... \
python -m gepa_sidecar.server
```

Point `RouterConfig.promptOptimization.bridge.sidecarUrl` at `http://127.0.0.1:8765`.

Endpoints:
- `GET /health`
- `POST /optimize` — evolves a system prompt for a request class (uses GEPA + judge)
- `POST /ledger`   — appends a usage entry (ROI tracking)

The `/optimize` endpoint enforces:
1. ≥ `min_references` reference outputs on disk for the class (offline harvest
   them via your shadow router or expensive-model bootstrap).
2. Final quality gate: held-out sample's mean judge score ≥ `min_quality_score`.
3. Per-call budget: `maxReflectionUsd` and `maxOptimizationSeconds` honored.

## Judge

`LLMJudge` uses Claude with:
- Prompt caching on the system rubric (one full-input bill per batch, then
  cache reads).
- Pairwise A/B with position swap to suppress positional bias.
- Adaptive retries on connection / 429 / 5xx with jittered exponential backoff.
- Structured JSON output validated and clamped to [0,1].
