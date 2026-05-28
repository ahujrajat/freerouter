"""FreeRouter GEPA optimization sidecar.

Two surfaces:
- Offline optimizer (`optimize_config.py`) — evolves RouterConfig artifacts against
  historical telemetry, using `scripts/score-candidate.ts` as the replay backend.
- Online sidecar (`server.py`) — HTTP server invoked by `GepaBridge` for
  per-request prompt optimization.
"""

__version__ = "0.1.0"
