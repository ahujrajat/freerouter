"""Offline GEPA driver for RouterConfig optimization.

Reads telemetry, runs `gepa.optimize_anything` against the TS replay scorer,
and writes the evolved candidate to disk for the host to hot-reload.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    import gepa
except ImportError:  # pragma: no cover — gepa is a runtime install
    gepa = None  # type: ignore

from .replay_evaluator import ReplayContext, make_evaluator


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Optimize a FinRouter config with GEPA.")
    parser.add_argument("--seed", required=True, help="path to seed candidate JSON")
    parser.add_argument("--telemetry", required=True, help="JSONL telemetry file (FileTelemetrySink output)")
    parser.add_argument("--pricing", required=True, help="pricing snapshot JSON (ReplayPricingMap)")
    parser.add_argument("--out", required=True, help="where to write the optimized candidate")
    parser.add_argument("--score-script", default="scripts/score-candidate.ts",
                        help="path to scripts/score-candidate.ts")
    parser.add_argument("--budget", choices=["light", "medium", "heavy"], default="light")
    parser.add_argument("--max-metric-calls", type=int, default=None)
    parser.add_argument("--reflection-model", default="claude-sonnet-4-6")
    parser.add_argument("--objective", default=(
        "Reduce total inference cost while preserving SLA "
        "(no realtime blocks) and honoring all admin rules."
    ))
    args = parser.parse_args(argv)

    if gepa is None:
        print("[optimize-config] gepa package not installed. Run `pip install gepa`.", file=sys.stderr)
        return 2

    seed = json.loads(Path(args.seed).read_text("utf-8"))
    candidate: dict[str, str] = {}
    if "rules" in seed:
        candidate["admin_rules"] = json.dumps(seed["rules"].get("rules", []), indent=2)
    if "costOptimization" in seed:
        candidate["candidate_models"] = json.dumps(
            seed["costOptimization"].get("candidateModels", []),
        )
    if "budgets" in seed:
        candidate["budgets"] = json.dumps(seed["budgets"], indent=2)

    if not candidate:
        print("[optimize-config] seed has no GEPA-tunable components.", file=sys.stderr)
        return 1

    ctx = ReplayContext(
        telemetry_path=Path(args.telemetry),
        pricing_path=Path(args.pricing),
        score_script=Path(args.score_script),
    )
    evaluator = make_evaluator(ctx)

    cfg_kwargs: dict[str, Any] = {
        "reflection_lm": args.reflection_model,
    }
    if args.max_metric_calls is not None:
        cfg_kwargs["max_metric_calls"] = args.max_metric_calls
    else:
        cfg_kwargs["auto"] = args.budget

    result = gepa.optimize_anything(
        seed_candidate=candidate,
        evaluator=evaluator,
        objective=args.objective,
        background=(
            "The artifact is a FinRouter routing config (TS). "
            "GEPA evaluates candidates via the real router's logic over a "
            "replay of historical SpendRecords. Block rate on realtime requests "
            "MUST stay below 1%."
        ),
        config=gepa.GEPAConfig(**cfg_kwargs),
    )

    best: dict[str, str] | str = result.best_candidate
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(best, dict):
        merged: dict[str, Any] = {}
        if "admin_rules" in best:
            merged["rules"] = {"rules": json.loads(best["admin_rules"]), "mode": "pin-wins"}
        if "candidate_models" in best:
            merged["costOptimization"] = {
                "strategy": "balanced",
                "candidateModels": json.loads(best["candidate_models"]),
            }
        if "budgets" in best:
            merged["budgets"] = json.loads(best["budgets"])
        out_path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    else:
        out_path.write_text(str(best), encoding="utf-8")

    print(f"[optimize-config] wrote {out_path} (score={result.val_aggregate_scores[result.best_idx]:.4f}, "
          f"total_metric_calls={result.total_metric_calls})")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
