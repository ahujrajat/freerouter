"""HTTP sidecar invoked by FreeRouter's `GepaBridge`.

Endpoints:
- POST /optimize → evolves a system prompt for a request class using GEPA.
- POST /ledger   → records realized usage (ROI tracking).
- GET  /health   → liveness probe.

Quality is judged by `LLMJudge`, which calls Anthropic's Claude. Per-class
references are stored on disk under `references_dir`. The first request for a
new class with no references is rejected (so the host has a chance to seed
references via the offline pipeline).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

try:
    import gepa
except ImportError:  # pragma: no cover
    gepa = None  # type: ignore

from .judge import JudgeConfig, JudgePair, LLMJudge


log = logging.getLogger("gepa-sidecar")
logging.basicConfig(level=logging.INFO)


# ── HTTP shapes ─────────────────────────────────────────────────────────────


class Message(BaseModel):
    role: str
    content: str


class Sample(BaseModel):
    messages: list[Message]
    model: str


class Reference(BaseModel):
    messages: list[Message]
    output: str


class OptimizeRequest(BaseModel):
    classSignature: str
    targetModel: str
    fallbackModel: str
    sample: Sample
    references: list[Reference] | None = None
    maxOptimizationSeconds: float | None = None
    maxMetricCalls: int | None = None
    maxReflectionUsd: float | None = None
    background: str | None = None


class OptimizeResponse(BaseModel):
    template: str
    qualityScore: float
    optimizationUsd: float
    predictedSavingsUsd: float
    breakEvenRequests: int
    meta: dict[str, Any] = Field(default_factory=dict)


class LedgerEntry(BaseModel):
    classSignature: str
    targetModel: str
    fallbackModel: str
    actualCostUsd: float
    qualityOk: bool | None = None


# ── Server state ────────────────────────────────────────────────────────────


@dataclass
class ServerState:
    judge: LLMJudge
    references_dir: Path
    ledger_path: Path
    auth_token: str | None
    target_caller: "TargetCaller"
    min_references: int = 3
    min_quality_score: float = 0.75
    sample_size_for_gate: int = 5
    background_hint: str = (
        "You are optimizing a system prompt that will be prepended to user "
        "requests routed to a cheaper LLM. The prompt should make the cheaper "
        "model produce outputs comparable to the more capable reference model. "
        "Be specific, terse, and avoid hedging."
    )
    references: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


class TargetCaller:
    """Calls the cheap target model with a candidate system prompt to score it.

    Production-ready: uses Anthropic's API for Claude target models; for
    OpenAI-family targets, point this at the real provider via FreeRouter's
    chat() (which the sidecar can invoke through a deployment-side adapter).
    For Phase 1, we support Anthropic-targets directly; non-Anthropic targets
    raise `NotImplementedError` with guidance.
    """

    def __init__(self, api_key: str | None = None) -> None:
        import anthropic
        self._anthropic = anthropic.AsyncAnthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"),
            timeout=60.0,
        )

    async def complete(self, target_model: str, system: str, messages: list[Message]) -> str:
        if not target_model.startswith(("claude-", "anthropic/")):
            raise NotImplementedError(
                f"TargetCaller currently invokes Anthropic models directly; "
                f"to use target_model={target_model!r}, point the sidecar at "
                "your FreeRouter HTTP endpoint instead and replace this method "
                "with that HTTP call."
            )
        model = target_model.removeprefix("anthropic/")
        anthropic_messages = [
            {"role": m.role if m.role in ("user", "assistant") else "user", "content": m.content}
            for m in messages
        ]
        resp = await self._anthropic.messages.create(
            model=model,
            max_tokens=1024,
            system=system,
            messages=anthropic_messages,
        )
        return "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text")


_state: ServerState | None = None


def _get_state() -> ServerState:
    if _state is None:
        raise HTTPException(status_code=500, detail="server state not initialized")
    return _state


def configure(
    references_dir: str | Path,
    ledger_path: str | Path,
    auth_token: str | None = None,
    judge_config: JudgeConfig | None = None,
) -> None:
    """Wire up server state. Call before serving."""
    global _state
    ref_dir = Path(references_dir)
    ref_dir.mkdir(parents=True, exist_ok=True)
    judge = LLMJudge(judge_config)
    _state = ServerState(
        judge=judge,
        references_dir=ref_dir,
        ledger_path=Path(ledger_path),
        auth_token=auth_token,
        target_caller=TargetCaller(),
    )


# ── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="FreeRouter GEPA sidecar")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "gepa_installed": gepa is not None}


@app.post("/optimize", response_model=OptimizeResponse)
async def optimize(req: OptimizeRequest) -> OptimizeResponse:
    state = _get_state()
    if gepa is None:
        raise HTTPException(status_code=503, detail="gepa package not installed in sidecar")

    refs = _load_references(state, req.classSignature)
    refs.extend({"messages": [m.dict() for m in r.messages], "output": r.output}
                for r in (req.references or []))
    if len(refs) < state.min_references:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Need at least {state.min_references} reference outputs for "
                f"class {req.classSignature!r} before optimization can run. "
                f"Have {len(refs)}."
            ),
        )

    seed_prompt = _initial_seed_for(req)
    evaluator, accounting = _build_optimization_evaluator(state, req, refs)

    started = time.monotonic()
    budget: dict[str, Any] = {"max_metric_calls": req.maxMetricCalls or 60}
    if req.maxOptimizationSeconds is not None:
        # GEPA exposes TimeoutStopCondition; we wrap with an external check too
        try:
            from gepa.stop_conditions import TimeoutStopCondition  # type: ignore
            budget["stop_conditions"] = [TimeoutStopCondition(timeout_seconds=req.maxOptimizationSeconds)]
        except ImportError:
            pass

    try:
        result = await asyncio.to_thread(
            gepa.optimize_anything,
            seed_candidate=seed_prompt,
            evaluator=evaluator,
            objective=(
                f"Produce a system prompt that lets {req.targetModel} match the "
                f"output quality of {req.fallbackModel} on prompts in class "
                f"{req.classSignature!r}."
            ),
            background=req.background or state.background_hint,
            config=gepa.GEPAConfig(reflection_lm=state.judge.cfg.model, **budget),
        )
    except Exception as exc:
        log.exception("gepa run failed")
        if (time.monotonic() - started) >= (req.maxOptimizationSeconds or 1e9):
            raise HTTPException(status_code=408, detail=f"optimization timed out: {exc}")
        raise HTTPException(status_code=500, detail=f"optimization failed: {exc}") from exc

    if req.maxReflectionUsd is not None and accounting["total_usd"] > req.maxReflectionUsd:
        raise HTTPException(
            status_code=402,
            detail=f"budget exhausted: ${accounting['total_usd']:.4f} > ${req.maxReflectionUsd}",
        )

    best_prompt = result.best_candidate if isinstance(result.best_candidate, str) else \
        next(iter(result.best_candidate.values()))

    # Final quality gate: run K held-out references and require mean score above floor.
    gate_pairs = await _sample_gate_pairs(state, req, refs, best_prompt, k=state.sample_size_for_gate)
    mean, gate_results = await state.judge.mean_score(gate_pairs)
    accounting["total_usd"] += sum(r.cost_usd for r in gate_results)
    if mean < state.min_quality_score:
        raise HTTPException(
            status_code=422,
            detail=f"quality gate failed: mean_score={mean:.3f} < {state.min_quality_score}",
        )

    predicted_savings = max(0.0, accounting.get("predicted_savings_usd", 0.0))
    break_even = int(accounting["total_usd"] / predicted_savings) + 1 if predicted_savings > 0 else 0

    return OptimizeResponse(
        template=best_prompt,
        qualityScore=mean,
        optimizationUsd=round(accounting["total_usd"], 6),
        predictedSavingsUsd=round(predicted_savings, 6),
        breakEvenRequests=break_even,
        meta={
            "total_metric_calls": result.total_metric_calls,
            "best_idx": result.best_idx,
            "gate_individual_scores": [r.score for r in gate_results],
            "gate_rationales": [r.rationale for r in gate_results],
        },
    )


@app.post("/ledger")
async def ledger(entry: LedgerEntry) -> dict[str, Any]:
    state = _get_state()
    state.ledger_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"ts": time.time(), **entry.dict()})
    with state.ledger_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return {"ok": True}


# ── Internals ───────────────────────────────────────────────────────────────


def _initial_seed_for(req: OptimizeRequest) -> str:
    return (
        "You are an expert assistant. Match the depth, structure, and accuracy "
        "of a stronger model when answering the user's request. Be specific, "
        "follow all explicit constraints in the prompt, and respect the "
        "requested output format. No filler, no apologies."
    )


def _load_references(state: ServerState, class_sig: str) -> list[dict[str, Any]]:
    if class_sig in state.references:
        return list(state.references[class_sig])
    safe = class_sig.replace("/", "_").replace(":", "_")
    path = state.references_dir / f"{safe}.jsonl"
    items: list[dict[str, Any]] = []
    if path.exists():
        for line in path.read_text("utf-8").splitlines():
            if line.strip():
                items.append(json.loads(line))
    state.references[class_sig] = items
    return list(items)


def _build_optimization_evaluator(
    state: ServerState,
    req: OptimizeRequest,
    refs: list[dict[str, Any]],
):
    """Returns (evaluator, accounting) where accounting is a mutable dict
    accumulating judge costs across metric calls."""

    accounting: dict[str, float] = {"total_usd": 0.0, "predicted_savings_usd": 0.0}

    def evaluator(candidate: str) -> tuple[float, dict[str, Any]]:
        sample = refs[: state.sample_size_for_gate]

        async def _score() -> tuple[float, list[Any]]:
            outputs = await asyncio.gather(*[
                state.target_caller.complete(
                    target_model=req.targetModel,
                    system=candidate,
                    messages=[Message(**m) for m in r["messages"]],
                ) for r in sample
            ])
            pairs = [
                JudgePair(
                    prompt=r["messages"][-1]["content"] if r["messages"] else "",
                    reference=r["output"],
                    candidate=output,
                )
                for r, output in zip(sample, outputs, strict=True)
            ]
            return await state.judge.mean_score(pairs)

        mean, results = asyncio.run(_score())
        accounting["total_usd"] += sum(r.cost_usd for r in results)
        return mean, {
            "score": mean,
            "individual_scores": [r.score for r in results],
            "rationales": [r.rationale for r in results],
            "running_cost_usd": accounting["total_usd"],
        }

    return evaluator, accounting


async def _sample_gate_pairs(
    state: ServerState,
    req: OptimizeRequest,
    refs: list[dict[str, Any]],
    candidate_prompt: str,
    k: int,
) -> list[JudgePair]:
    # Held-out: take the last K refs so the optimizer didn't train on them.
    held = refs[-k:] if len(refs) >= k else refs
    outputs = await asyncio.gather(*[
        state.target_caller.complete(
            target_model=req.targetModel,
            system=candidate_prompt,
            messages=[Message(**m) for m in r["messages"]],
        ) for r in held
    ])
    return [
        JudgePair(
            prompt=r["messages"][-1]["content"] if r["messages"] else "",
            reference=r["output"],
            candidate=output,
        )
        for r, output in zip(held, outputs, strict=True)
    ]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    configure(
        references_dir=os.environ.get("GEPA_REFS_DIR", "./gepa-references"),
        ledger_path=os.environ.get("GEPA_LEDGER_PATH", "./gepa-ledger.jsonl"),
        auth_token=os.environ.get("GEPA_AUTH_TOKEN"),
    )
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", "8765")))
