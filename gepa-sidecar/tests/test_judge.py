"""Unit tests for the production judge.

We don't make real network calls — the Anthropic client is monkey-patched.
The tests cover: parsing, clamping, swap-correction averaging, retry logic,
cost accounting, and concurrency limits.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import pytest

from gepa_sidecar.judge import (
    DimensionScores, JudgeConfig, JudgePair, LLMJudge,
    _average_dimensions, _clamp01, _estimate_cost, _parse_judge_json,
)


class _FakeUsage:
    def __init__(self, in_t=100, out_t=80, cache_create=0, cache_read=0):
        self.input_tokens = in_t
        self.output_tokens = out_t
        self.cache_creation_input_tokens = cache_create
        self.cache_read_input_tokens = cache_read


@dataclass
class _FakeBlock:
    type: str
    text: str


class _FakeResponse:
    def __init__(self, text: str, stop="end_turn", usage=None):
        self.content = [_FakeBlock("text", text)]
        self.stop_reason = stop
        self.usage = usage or _FakeUsage()


class _FakeMessages:
    def __init__(self, responses: list[Any]):
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self._responses:
            raise RuntimeError("no more fake responses")
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class _FakeClient:
    def __init__(self, responses: list[Any]):
        self.messages = _FakeMessages(responses)


@pytest.fixture
def _judge_with(monkeypatch):
    def _build(responses: list[Any], config: JudgeConfig | None = None) -> tuple[LLMJudge, _FakeClient]:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        cfg = config or JudgeConfig(use_pairwise_swap=False, max_retries=2, initial_backoff_s=0.01)
        j = LLMJudge(cfg)
        fake = _FakeClient(responses)
        j._client = fake  # type: ignore[attr-defined]
        return j, fake
    return _build


_GOOD_JSON = json.dumps({
    "correctness": 0.9,
    "completeness": 0.8,
    "instruction_following": 0.95,
    "structural_fidelity": 1.0,
    "conciseness": 0.7,
    "rationale": "Candidate matches reference closely; slightly less concise.",
})


def test_clamp_handles_nan_and_out_of_range():
    assert _clamp01(float("nan")) == 0.0
    assert _clamp01(-1.0) == 0.0
    assert _clamp01(1.5) == 1.0
    assert _clamp01(0.5) == 0.5


def test_parse_judge_json_tolerates_surrounding_whitespace():
    raw = "  here is the result:\n" + _GOOD_JSON + "\nthanks"
    parsed = _parse_judge_json(raw)
    assert parsed is not None
    dims, rationale = parsed
    assert dims.correctness == 0.9
    assert "matches reference" in rationale


def test_parse_judge_json_rejects_garbage():
    assert _parse_judge_json("nope, no json here") is None
    assert _parse_judge_json('{"correctness": "very good"}') is None  # non-numeric


def test_average_dimensions_combines_swap():
    a = DimensionScores(0.8, 0.7, 0.9, 1.0, 0.6)
    b = DimensionScores(0.6, 0.9, 0.7, 0.8, 0.8)
    avg = _average_dimensions(a, b)
    assert avg.correctness == pytest.approx(0.7)
    assert avg.completeness == pytest.approx(0.8)


def test_dimension_aggregate_weights_correctness_heaviest():
    # Correctness alone (everything else 0) must beat all-other-axes-perfect
    # with zero correctness — i.e., wrong-but-fluent scores below correct-but-
    # terse. This is the production safety property.
    high_correctness = DimensionScores(1.0, 0.0, 0.0, 0.0, 0.0).aggregate()
    low_correctness  = DimensionScores(0.0, 1.0, 1.0, 1.0, 1.0).aggregate()
    assert high_correctness > low_correctness


@pytest.mark.asyncio
async def test_judge_single_call_parses_and_scores(_judge_with):
    judge, fake = _judge_with([_FakeResponse(_GOOD_JSON)])
    pair = JudgePair(prompt="explain X", reference="A says X", candidate="B says X")
    result = await judge.judge(pair)
    assert 0.0 <= result.score <= 1.0
    assert result.dimensions.correctness == 0.9
    assert result.cost_usd > 0
    assert len(fake.messages.calls) == 1


@pytest.mark.asyncio
async def test_judge_pairwise_swap_doubles_calls(_judge_with):
    judge, fake = _judge_with(
        [_FakeResponse(_GOOD_JSON), _FakeResponse(_GOOD_JSON)],
        JudgeConfig(use_pairwise_swap=True, max_retries=0, initial_backoff_s=0.01),
    )
    pair = JudgePair(prompt="p", reference="r", candidate="c")
    result = await judge.judge(pair)
    assert len(fake.messages.calls) == 2
    assert len(result.raw_judgements) == 2


@pytest.mark.asyncio
async def test_judge_retries_on_truncated_response(_judge_with):
    judge, fake = _judge_with(
        [_FakeResponse("{incomplete", stop="max_tokens"), _FakeResponse(_GOOD_JSON)],
        JudgeConfig(use_pairwise_swap=False, max_retries=3, initial_backoff_s=0.001),
    )
    result = await judge.judge(JudgePair(prompt="p", reference="r", candidate="c"))
    assert result.score > 0
    assert len(fake.messages.calls) == 2


@pytest.mark.asyncio
async def test_judge_concurrency_limit_enforced(_judge_with):
    # Build many slow responses; assert that at any point at most `concurrency`
    # calls are in-flight.
    inflight = 0
    peak = 0
    lock = asyncio.Lock()

    class _SlowMessages:
        async def create(self, **kwargs):
            nonlocal inflight, peak
            async with lock:
                inflight += 1
                peak = max(peak, inflight)
            await asyncio.sleep(0.02)
            async with lock:
                inflight -= 1
            return _FakeResponse(_GOOD_JSON)

    judge, fake = _judge_with([], JudgeConfig(
        use_pairwise_swap=False, max_retries=0, concurrency=2, initial_backoff_s=0.001,
    ))
    fake.messages = _SlowMessages()  # type: ignore[assignment]
    judge._client = fake  # type: ignore[attr-defined]
    pairs = [JudgePair(prompt=f"p{i}", reference="r", candidate="c") for i in range(8)]
    await judge.judge_batch(pairs)
    assert peak <= 2


def test_cost_accounting_includes_cache():
    cfg = JudgeConfig()
    usage = _FakeUsage(in_t=100, out_t=50, cache_create=1000, cache_read=2000)
    cost = _estimate_cost(usage, cfg)
    # cache_read uses cached_input_price_per_m (0.30); cache_create at full input price
    expected = (
        (100 / 1_000_000) * cfg.input_price_per_m
        + (1000 / 1_000_000) * cfg.input_price_per_m
        + (2000 / 1_000_000) * cfg.cached_input_price_per_m
        + (50 / 1_000_000) * cfg.output_price_per_m
    )
    assert cost == round(expected, 6)


@pytest.mark.asyncio
async def test_mean_score_aggregates(_judge_with):
    responses = [
        _FakeResponse(json.dumps({
            "correctness": 0.8, "completeness": 0.8, "instruction_following": 0.8,
            "structural_fidelity": 0.8, "conciseness": 0.8, "rationale": "",
        })),
        _FakeResponse(json.dumps({
            "correctness": 0.4, "completeness": 0.4, "instruction_following": 0.4,
            "structural_fidelity": 0.4, "conciseness": 0.4, "rationale": "",
        })),
    ]
    judge, _ = _judge_with(responses, JudgeConfig(
        use_pairwise_swap=False, max_retries=0, initial_backoff_s=0.001,
    ))
    pairs = [JudgePair(prompt=f"p{i}", reference="r", candidate="c") for i in range(2)]
    mean, results = await judge.mean_score(pairs)
    assert len(results) == 2
    assert 0.4 <= mean <= 0.8
