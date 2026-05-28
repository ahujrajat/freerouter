"""GEPA evaluator that scores candidate RouterConfigs by shelling out to
the TypeScript replay scorer.

This is the linchpin design choice: instead of reimplementing the router's
decision logic in Python (which would drift), we invoke the *real* TS code
via `scripts/score-candidate.ts`. Parity is guaranteed by construction.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ReplayContext:
    """Static inputs to every evaluator call."""

    telemetry_path: Path
    pricing_path: Path
    score_script: Path  # path to scripts/score-candidate.ts
    node_bin: str = "node"
    tsx_args: tuple[str, ...] = ("--import", "tsx")


@dataclass
class ScoreBreakdown:
    cost_score: float
    sla_score: float
    quality_score: float
    budget_score: float
    score: float
    diagnostics: dict[str, Any]


def make_evaluator(ctx: ReplayContext):
    """Return a function `evaluator(candidate) -> (score, side_info)` suitable
    for `gepa.optimize_anything`.
    """

    def evaluator(candidate: dict[str, str] | str) -> tuple[float, dict[str, Any]]:
        if isinstance(candidate, dict):
            cfg = _merge_into_base(candidate)
        else:
            cfg = json.loads(candidate)

        # Validation gate — bail early on malformed candidates.
        from .validator import validate_candidate
        ok, err = validate_candidate(cfg)
        if not ok:
            return -1e9, {"reason": "schema-validation-failed", "error": err}

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(cfg, f)
            candidate_path = f.name

        try:
            result = subprocess.run(
                [ctx.node_bin, *ctx.tsx_args, str(ctx.score_script),
                 candidate_path, str(ctx.telemetry_path), str(ctx.pricing_path)],
                capture_output=True, text=True, timeout=120,
            )
        finally:
            Path(candidate_path).unlink(missing_ok=True)

        if result.returncode != 0:
            return -1e9, {"reason": "scorer-failed", "stderr": result.stderr[:2000]}

        try:
            agg = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            return -1e9, {"reason": "scorer-parse-error", "error": str(e)}

        breakdown = _score_aggregate(agg)
        return breakdown.score, {
            "summary": _human_summary(agg, breakdown),
            "kpis": agg,
            **breakdown.diagnostics,
        }

    return evaluator


def _score_aggregate(agg: dict[str, Any]) -> ScoreBreakdown:
    baseline = agg.get("baselineCostUsd", 0) or 1e-9
    candidate = agg.get("candidateCostUsd", 0)
    realtime_blocks = agg.get("realtimeBlocks", 0)
    records = agg.get("recordsScored", 1) or 1

    cost_score = max(0.0, 1 - candidate / baseline)
    sla_score = 1 - realtime_blocks / max(records, 1)
    # Quality and budget proxies are placeholders until tier-2 telemetry lands.
    quality_score = 1.0
    budget_score = 1.0

    score = (
        0.45 * cost_score
        + 0.25 * quality_score
        + 0.20 * sla_score
        + 0.10 * budget_score
    )
    if sla_score < 0.99:
        score -= 0.5  # cliff penalty for realtime blocks

    return ScoreBreakdown(
        cost_score=cost_score,
        sla_score=sla_score,
        quality_score=quality_score,
        budget_score=budget_score,
        score=score,
        diagnostics={
            "worst_examples": _top_regressions(agg, n=5),
            "per_org_delta": agg.get("costDeltaByOrg", {}),
            "routing_matrix": agg.get("routingMatrix", {}),
        },
    )


def _top_regressions(agg: dict[str, Any], n: int) -> list[dict[str, Any]]:
    """Pick orgs with the largest positive (cost-increasing) deltas — those are
    the regressions the reflection LM should focus on improving."""
    deltas = agg.get("costDeltaByOrg", {}) or {}
    sorted_orgs = sorted(deltas.items(), key=lambda kv: -kv[1])
    return [{"orgId": k, "deltaUsd": v} for k, v in sorted_orgs[:n] if v > 0]


def _human_summary(agg: dict[str, Any], b: ScoreBreakdown) -> str:
    return (
        f"Replayed {agg.get('recordsScored', 0)} records. "
        f"Cost {agg.get('candidateCostUsd', 0):.4f} vs baseline "
        f"{agg.get('baselineCostUsd', 0):.4f} (savings {b.cost_score:.1%}). "
        f"{agg.get('blocks', 0)} blocks ({agg.get('realtimeBlocks', 0)} realtime). "
        f"{agg.get('modelSwitches', 0)} model switches, "
        f"{agg.get('downgrades', 0)} downgrades."
    )


def _merge_into_base(candidate: dict[str, str]) -> dict[str, Any]:
    """Translate a multi-component GEPA candidate (`dict[str, str]` of JSON
    fragments) into a single RouterConfig-shaped dict for the scorer.
    """
    out: dict[str, Any] = {}
    if "admin_rules" in candidate:
        try:
            out["rules"] = {"rules": json.loads(candidate["admin_rules"]), "mode": "pin-wins"}
        except json.JSONDecodeError:
            pass
    if "candidate_models" in candidate:
        try:
            out["costOptimization"] = {
                "strategy": "balanced",
                "candidateModels": json.loads(candidate["candidate_models"]),
            }
        except json.JSONDecodeError:
            pass
    if "budgets" in candidate:
        try:
            out["budgets"] = json.loads(candidate["budgets"])
        except json.JSONDecodeError:
            pass
    return out
