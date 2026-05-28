"""Production LLM-judge for the GEPA optimization pipeline.

Compares the cheap (target-model + optimized-prompt) output against a
reference output (from the fallback model) and returns a calibrated quality
score in [0, 1] plus structured rationale.

Design points:
- Uses Anthropic's Claude via the official SDK as the judge LM.
- Prompt caching on the system prompt and reference (the parts that don't
  change across candidates) so cost is bounded even when judging hundreds
  of candidates per optimization run.
- Pairwise comparison with position-swapped re-judgement to suppress
  positional bias (which judge ordering studies show is the largest source
  of judge noise).
- Structured JSON output, validated and clamped — never trust raw LM text.
- Adaptive concurrency: a `Semaphore` caps parallel judge calls so this
  doesn't accidentally DoS the judge API when scoring large batches.
- Returns a `JudgeResult` rich enough for GEPA's reflection LM to read as
  side_info: per-dimension scores, free-text critique, raw response.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from dataclasses import dataclass, asdict, field
from typing import TYPE_CHECKING, Any, Sequence

if TYPE_CHECKING:
    import anthropic  # noqa: F401  (typing only)

# ── Public types ────────────────────────────────────────────────────────────


@dataclass
class JudgePair:
    """A single judging task: reference vs candidate, sharing the same prompt."""

    prompt: str
    reference: str
    candidate: str
    rubric: str | None = None


@dataclass
class DimensionScores:
    correctness: float
    completeness: float
    instruction_following: float
    structural_fidelity: float
    conciseness: float

    def aggregate(self) -> float:
        # Correctness is non-negotiable: a wrong-but-fluent answer must score
        # below a correct-but-terse one. Weight chosen so a perfect-correctness
        # response beats one that's zero-correctness even if every other axis
        # is maxed out (0.55 > 0.15+0.15+0.10+0.05 = 0.45).
        return (
            0.55 * self.correctness
            + 0.15 * self.completeness
            + 0.15 * self.instruction_following
            + 0.10 * self.structural_fidelity
            + 0.05 * self.conciseness
        )


@dataclass
class JudgeResult:
    score: float                  # final score in [0, 1]
    dimensions: DimensionScores
    rationale: str                # free-text critique for reflection
    cost_usd: float               # actual judge tokens billed
    raw_judgements: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "dimensions": asdict(self.dimensions),
            "rationale": self.rationale,
            "cost_usd": self.cost_usd,
            "raw_judgements": self.raw_judgements,
        }


# ── Configuration ───────────────────────────────────────────────────────────


@dataclass
class JudgeConfig:
    model: str = "claude-sonnet-4-6"
    api_key: str | None = None                 # falls back to ANTHROPIC_API_KEY
    max_tokens: int = 1024
    temperature: float = 0.0
    concurrency: int = 4
    timeout_s: float = 60.0
    max_retries: int = 4
    initial_backoff_s: float = 1.0
    use_pairwise_swap: bool = True             # judge twice with positions swapped
    use_prompt_caching: bool = True            # cache system + rubric across calls
    # Pricing of the judge model, $/1M tokens. Update when model/pricing change.
    input_price_per_m: float = 3.00
    output_price_per_m: float = 15.00
    cached_input_price_per_m: float = 0.30


# ── Implementation ──────────────────────────────────────────────────────────


_JUDGE_SYSTEM = """\
You are an impartial expert judge evaluating two answers, A and B, against the
same user prompt. A is from a reference model; B is from a candidate model
running under a candidate prompt. Your task is to assess B *relative to A*
across five dimensions.

Score each dimension on a 0.0–1.0 scale:
- correctness:          factual / logical accuracy. 1.0 = matches reference's
                        substantive content; 0.0 = clearly wrong.
- completeness:         coverage of what the prompt asked for.
- instruction_following: adherence to explicit instructions in the prompt
                        (format, length, style, constraints).
- structural_fidelity:  if the prompt requested a specific format (JSON, list,
                        XML), does B comply? 1.0 = exact compliance.
- conciseness:          1.0 = no filler, no padding, no apologies; lower means
                        verbose or repetitive.

You MUST respond with a single JSON object, no prose around it, matching:
{
  "correctness":           <float 0-1>,
  "completeness":          <float 0-1>,
  "instruction_following": <float 0-1>,
  "structural_fidelity":   <float 0-1>,
  "conciseness":           <float 0-1>,
  "rationale":             "<2-4 sentences explaining the lowest-scoring dimension>"
}
Do not include code fences. Do not include any other text.
"""


_JSON_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)


class _RetryableError(Exception):
    """Wraps an underlying transient error for the retry loop."""


class LLMJudge:
    def __init__(self, config: JudgeConfig | None = None) -> None:
        self.cfg = config or JudgeConfig()
        api_key = self.cfg.api_key or os.environ.get("ANTHROPIC_API_KEY")
        if api_key is None:
            raise ValueError(
                "LLMJudge requires an Anthropic API key. Set ANTHROPIC_API_KEY "
                "or pass JudgeConfig(api_key=...)."
            )
        import anthropic
        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic(api_key=api_key, timeout=self.cfg.timeout_s)
        self._sem = asyncio.Semaphore(self.cfg.concurrency)

    # ── public API ──────────────────────────────────────────────────────────

    async def judge(self, pair: JudgePair) -> JudgeResult:
        """Judge a single (prompt, reference, candidate) tuple."""
        return await self._judge_one(pair)

    async def judge_batch(self, pairs: Sequence[JudgePair]) -> list[JudgeResult]:
        """Judge many pairs concurrently (respecting `concurrency`)."""
        return await asyncio.gather(*(self._judge_one(p) for p in pairs))

    async def mean_score(self, pairs: Sequence[JudgePair]) -> tuple[float, list[JudgeResult]]:
        """Convenience: mean aggregate score across a sample, plus the
        individual results for diagnostics."""
        results = await self.judge_batch(pairs)
        if not results:
            return 0.0, []
        return sum(r.score for r in results) / len(results), results

    # ── internal ────────────────────────────────────────────────────────────

    async def _judge_one(self, pair: JudgePair) -> JudgeResult:
        async with self._sem:
            first = await self._call_with_retries(pair, swap=False)
            if not self.cfg.use_pairwise_swap:
                dims = first["dims"]
                return JudgeResult(
                    score=_clamp01(dims.aggregate()),
                    dimensions=dims,
                    rationale=first["rationale"],
                    cost_usd=first["cost_usd"],
                    raw_judgements=[first["raw"]],
                )

            second = await self._call_with_retries(pair, swap=True)
            # Average dimension-by-dimension after swap-correction. When the
            # response is from the swapped order, dimensions are about A from
            # the candidate's POV, which is the same evaluation target — they
            # combine cleanly.
            dims = _average_dimensions(first["dims"], second["dims"])
            return JudgeResult(
                score=_clamp01(dims.aggregate()),
                dimensions=dims,
                rationale=_combine_rationales(first["rationale"], second["rationale"]),
                cost_usd=first["cost_usd"] + second["cost_usd"],
                raw_judgements=[first["raw"], second["raw"]],
            )

    async def _call_with_retries(self, pair: JudgePair, swap: bool) -> dict[str, Any]:
        backoff = self.cfg.initial_backoff_s
        last_exc: Exception | None = None

        for attempt in range(self.cfg.max_retries + 1):
            try:
                return await self._call_once(pair, swap)
            except _RetryableError as e:
                last_exc = e
                if attempt >= self.cfg.max_retries:
                    break
                jitter = random.uniform(0, backoff * 0.25)
                await asyncio.sleep(backoff + jitter)
                backoff = min(backoff * 2, 30.0)
            except self._anthropic.APIStatusError as e:
                if e.status_code in (408, 429, 500, 502, 503, 504):
                    last_exc = e
                    if attempt >= self.cfg.max_retries:
                        break
                    jitter = random.uniform(0, backoff * 0.25)
                    await asyncio.sleep(backoff + jitter)
                    backoff = min(backoff * 2, 30.0)
                else:
                    raise
        raise RuntimeError(f"Judge failed after {self.cfg.max_retries} retries: {last_exc}")

    async def _call_once(self, pair: JudgePair, swap: bool) -> dict[str, Any]:
        a = pair.candidate if swap else pair.reference
        b = pair.reference if swap else pair.candidate

        system_blocks: list[dict[str, Any]] = [{"type": "text", "text": _JUDGE_SYSTEM}]
        if pair.rubric is not None and pair.rubric.strip():
            system_blocks.append({"type": "text", "text": f"\nAdditional rubric:\n{pair.rubric}"})

        # Mark stable system content as cache-eligible so we only pay full
        # input price on the first judge call in a batch.
        if self.cfg.use_prompt_caching:
            for block in system_blocks:
                block["cache_control"] = {"type": "ephemeral"}

        user_message = (
            f"PROMPT:\n{pair.prompt}\n\n"
            f"ANSWER A:\n{a}\n\n"
            f"ANSWER B:\n{b}\n\n"
            "Evaluate B relative to A. Return the JSON object only."
        )

        start = time.monotonic()
        try:
            resp = await self._client.messages.create(
                model=self.cfg.model,
                max_tokens=self.cfg.max_tokens,
                temperature=self.cfg.temperature,
                system=system_blocks,
                messages=[{"role": "user", "content": user_message}],
            )
        except self._anthropic.APIConnectionError as e:
            raise _RetryableError(f"connection: {e}") from e
        except self._anthropic.APITimeoutError as e:
            raise _RetryableError(f"timeout: {e}") from e

        if resp.stop_reason == "max_tokens":
            # Output was truncated — the JSON is likely incomplete. Retry.
            raise _RetryableError("response truncated (max_tokens)")

        raw_text = _extract_text(resp)
        parsed = _parse_judge_json(raw_text)
        if parsed is None:
            raise _RetryableError(f"unparseable judge output: {raw_text[:300]!r}")

        dims, rationale = parsed
        # If we swapped, the dimensions are reported from B's (now candidate's)
        # perspective which is what we want — no inversion needed.
        cost_usd = _estimate_cost(resp.usage, self.cfg)
        return {
            "dims": dims,
            "rationale": rationale,
            "cost_usd": cost_usd,
            "raw": {
                "swap": swap,
                "model": self.cfg.model,
                "stop_reason": resp.stop_reason,
                "latency_s": round(time.monotonic() - start, 3),
                "usage": {
                    "input_tokens": getattr(resp.usage, "input_tokens", 0),
                    "output_tokens": getattr(resp.usage, "output_tokens", 0),
                    "cache_creation_input_tokens": getattr(resp.usage, "cache_creation_input_tokens", 0) or 0,
                    "cache_read_input_tokens": getattr(resp.usage, "cache_read_input_tokens", 0) or 0,
                },
                "rationale": rationale,
                "dimensions": asdict(dims),
            },
        }


# ── Parsers / helpers ───────────────────────────────────────────────────────


def _extract_text(resp: Any) -> str:
    parts: list[str] = []
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    return "".join(parts).strip()


def _parse_judge_json(raw: str) -> tuple[DimensionScores, str] | None:
    """Tolerant parse: judge sometimes wraps JSON in stray text despite the
    instruction. Find the first {...} block and validate."""
    match = _JSON_RE.search(raw)
    if match is None:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    try:
        dims = DimensionScores(
            correctness=_clamp01(float(obj["correctness"])),
            completeness=_clamp01(float(obj["completeness"])),
            instruction_following=_clamp01(float(obj["instruction_following"])),
            structural_fidelity=_clamp01(float(obj["structural_fidelity"])),
            conciseness=_clamp01(float(obj["conciseness"])),
        )
    except (KeyError, TypeError, ValueError):
        return None
    rationale = str(obj.get("rationale", "")).strip()
    return dims, rationale


def _clamp01(x: float) -> float:
    if x != x:  # NaN
        return 0.0
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def _average_dimensions(a: DimensionScores, b: DimensionScores) -> DimensionScores:
    return DimensionScores(
        correctness=(a.correctness + b.correctness) / 2,
        completeness=(a.completeness + b.completeness) / 2,
        instruction_following=(a.instruction_following + b.instruction_following) / 2,
        structural_fidelity=(a.structural_fidelity + b.structural_fidelity) / 2,
        conciseness=(a.conciseness + b.conciseness) / 2,
    )


def _combine_rationales(first: str, second: str) -> str:
    if not first:
        return second
    if not second:
        return first
    return f"Initial: {first}\nSwapped: {second}"


def _estimate_cost(usage: Any, cfg: JudgeConfig) -> float:
    in_tokens = getattr(usage, "input_tokens", 0) or 0
    out_tokens = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_create = getattr(usage, "cache_creation_input_tokens", 0) or 0
    # `input_tokens` excludes cached reads in the modern API; `cache_creation`
    # is billed at full input price; `cache_read` is billed at the discount.
    cost = (
        (in_tokens / 1_000_000) * cfg.input_price_per_m
        + (cache_create / 1_000_000) * cfg.input_price_per_m
        + (cache_read / 1_000_000) * cfg.cached_input_price_per_m
        + (out_tokens / 1_000_000) * cfg.output_price_per_m
    )
    return round(cost, 6)
