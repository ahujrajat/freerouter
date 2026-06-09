"""Read auto-optimization candidates, call the GEPA sidecar to optimize them,
and write the optimized-prompt store. Stdlib only (mirrors pricing_fetcher.py).
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
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
