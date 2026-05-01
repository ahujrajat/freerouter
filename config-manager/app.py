"""Tkinter desktop app for editing FreeRouter configuration files.

The app reads and writes three artifacts in the operator's CWD by default:
  - freerouter.config.json  (main router config)
  - rules.json              (admin rules; FileRulesSource-compatible)
  - .env                    (FreeRouter-related environment variables)

Paths are taken from CLI flags. All writes are atomic and pre-validated.
The app never opens a network port; every operation is a local file write.
"""
from __future__ import annotations

import tkinter as tk
from copy import deepcopy
from tkinter import messagebox, simpledialog, ttk
from typing import Any, Callable

import config_io
from validators import validate_config, validate_rules

KNOWN_PROVIDERS = ["google", "openai", "anthropic", "mistral", "groq"]
KNOWN_ENV_VARS: list[tuple[str, str]] = [
    ("FREEROUTER_CONFIG", "Path to the FreeRouter config file"),
    ("ROUTER_MASTER_KEY", "64-char hex AES-256-GCM master key (BYOK store)"),
    ("FREEROUTER_NEW_KEY", "Replacement API key for `rotate-key` CLI"),
    ("PRICING_TOKEN", "Bearer token used by the pricing-refresh source"),
]
BUDGET_WINDOWS = ["hourly", "daily", "weekly", "monthly", "quarterly", "total"]
LIMIT_ACTIONS = ["block", "warn", "downgrade", "notify", "throttle"]
SCOPE_TYPES = ["global", "org", "department", "team", "user"]
RULE_ACTION_TYPES = ["pin", "strategy", "block"]
COST_STRATEGIES = ["cheapest", "balanced", "fastest"]


# ── Tiny form helpers ────────────────────────────────────────────────────

def _grid_label(parent: tk.Widget, text: str, row: int, col: int = 0, sticky: str = "w") -> ttk.Label:
    label = ttk.Label(parent, text=text)
    label.grid(row=row, column=col, sticky=sticky, padx=8, pady=4)
    return label


def _grid_entry(parent: tk.Widget, var: tk.Variable, row: int, col: int = 1, width: int = 36) -> ttk.Entry:
    entry = ttk.Entry(parent, textvariable=var, width=width)
    entry.grid(row=row, column=col, sticky="ew", padx=8, pady=4)
    return entry


def _grid_check(parent: tk.Widget, text: str, var: tk.BooleanVar, row: int, col: int = 1) -> ttk.Checkbutton:
    chk = ttk.Checkbutton(parent, text=text, variable=var)
    chk.grid(row=row, column=col, sticky="w", padx=8, pady=4)
    return chk


def _grid_combo(parent: tk.Widget, var: tk.StringVar, values: list[str], row: int, col: int = 1) -> ttk.Combobox:
    combo = ttk.Combobox(parent, textvariable=var, values=values, state="readonly", width=24)
    combo.grid(row=row, column=col, sticky="w", padx=8, pady=4)
    return combo


def _empty_to_none(value: str) -> str | None:
    return value if value.strip() else None


def _safe_int(value: str) -> int | None:
    value = value.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _safe_float(value: str) -> float | None:
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


# ── Modal dialogs ────────────────────────────────────────────────────────

class _ModalDialog(tk.Toplevel):
    def __init__(self, parent: tk.Widget, title: str):
        super().__init__(parent)
        self.transient(parent)
        self.title(title)
        self.resizable(False, False)
        self.result: dict[str, Any] | None = None
        self.body_frame = ttk.Frame(self, padding=12)
        self.body_frame.grid(row=0, column=0, sticky="nsew")
        self.button_frame = ttk.Frame(self, padding=(12, 0, 12, 12))
        self.button_frame.grid(row=1, column=0, sticky="e")
        ttk.Button(self.button_frame, text="Cancel", command=self.destroy).pack(side="right", padx=4)
        ttk.Button(self.button_frame, text="OK", command=self._on_ok).pack(side="right")
        self.bind("<Return>", lambda _e: self._on_ok())
        self.bind("<Escape>", lambda _e: self.destroy())

    def _on_ok(self) -> None:
        try:
            self.result = self.collect()
        except ValueError as exc:
            messagebox.showerror("Invalid input", str(exc), parent=self)
            return
        self.destroy()

    def collect(self) -> dict[str, Any]:  # pragma: no cover — overridden
        raise NotImplementedError


class BudgetDialog(_ModalDialog):
    def __init__(self, parent: tk.Widget, initial: dict[str, Any] | None = None):
        super().__init__(parent, title="Budget Policy")
        b = initial or {}
        scope = b.get("scope") or {"type": "global"}

        self.id_var = tk.StringVar(value=b.get("id", ""))
        self.window_var = tk.StringVar(value=b.get("window", "monthly"))
        self.scope_type_var = tk.StringVar(value=scope.get("type", "global"))
        self.org_var = tk.StringVar(value=scope.get("orgId", ""))
        self.dept_var = tk.StringVar(value=scope.get("departmentId", ""))
        self.team_var = tk.StringVar(value=scope.get("teamId", ""))
        self.user_var = tk.StringVar(value=scope.get("userId", ""))
        self.max_spend_var = tk.StringVar(value=str(b.get("maxSpendUsd", "")))
        self.max_tokens_var = tk.StringVar(value=str(b.get("maxTokens", "") or ""))
        self.max_requests_var = tk.StringVar(value=str(b.get("maxRequests", "") or ""))
        self.action_var = tk.StringVar(value=b.get("onLimitReached", "warn"))
        self.fallback_var = tk.StringVar(value=b.get("fallbackModel", ""))
        self.priority_var = tk.StringVar(value=str(b.get("priority", "") or ""))
        self.alerts_var = tk.StringVar(value=", ".join(str(t) for t in (b.get("alertThresholds") or [])))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        rows = [
            ("ID", self.id_var, "entry"),
            ("Window", self.window_var, ("combo", BUDGET_WINDOWS)),
            ("Scope type", self.scope_type_var, ("combo", SCOPE_TYPES)),
            ("orgId", self.org_var, "entry"),
            ("departmentId", self.dept_var, "entry"),
            ("teamId", self.team_var, "entry"),
            ("userId", self.user_var, "entry"),
            ("maxSpendUsd", self.max_spend_var, "entry"),
            ("maxTokens (optional)", self.max_tokens_var, "entry"),
            ("maxRequests (optional)", self.max_requests_var, "entry"),
            ("onLimitReached", self.action_var, ("combo", LIMIT_ACTIONS)),
            ("fallbackModel (downgrade only)", self.fallback_var, "entry"),
            ("priority (optional)", self.priority_var, "entry"),
            ("alertThresholds (CSV %)", self.alerts_var, "entry"),
        ]
        for r, (label, var, kind) in enumerate(rows):
            _grid_label(f, label, r)
            if kind == "entry":
                _grid_entry(f, var, r)
            else:
                _, values = kind  # type: ignore[misc]
                _grid_combo(f, var, values, r)

    def collect(self) -> dict[str, Any]:
        budget_id = self.id_var.get().strip()
        if not budget_id:
            raise ValueError("ID is required")
        max_spend = _safe_float(self.max_spend_var.get())
        if max_spend is None or max_spend < 0:
            raise ValueError("maxSpendUsd must be a non-negative number")
        scope_type = self.scope_type_var.get()
        scope: dict[str, Any] = {"type": scope_type}
        if scope_type == "org":
            if not self.org_var.get().strip():
                raise ValueError("orgId is required for org scope")
            scope["orgId"] = self.org_var.get().strip()
        elif scope_type == "department":
            if not (self.org_var.get().strip() and self.dept_var.get().strip()):
                raise ValueError("orgId and departmentId required for department scope")
            scope["orgId"] = self.org_var.get().strip()
            scope["departmentId"] = self.dept_var.get().strip()
        elif scope_type == "team":
            if not (self.org_var.get().strip() and self.team_var.get().strip()):
                raise ValueError("orgId and teamId required for team scope")
            scope["orgId"] = self.org_var.get().strip()
            scope["teamId"] = self.team_var.get().strip()
        elif scope_type == "user":
            if not self.user_var.get().strip():
                raise ValueError("userId required for user scope")
            scope["userId"] = self.user_var.get().strip()

        action = self.action_var.get()
        result: dict[str, Any] = {
            "id": budget_id,
            "scope": scope,
            "window": self.window_var.get(),
            "maxSpendUsd": max_spend,
            "onLimitReached": action,
        }
        max_tokens = _safe_int(self.max_tokens_var.get())
        if max_tokens is not None:
            result["maxTokens"] = max_tokens
        max_requests = _safe_int(self.max_requests_var.get())
        if max_requests is not None:
            result["maxRequests"] = max_requests
        if action == "downgrade":
            fallback = self.fallback_var.get().strip()
            if not fallback:
                raise ValueError("fallbackModel is required when onLimitReached='downgrade'")
            result["fallbackModel"] = fallback
        priority = _safe_int(self.priority_var.get())
        if priority is not None:
            result["priority"] = priority
        alerts_raw = self.alerts_var.get().strip()
        if alerts_raw:
            try:
                result["alertThresholds"] = [int(x.strip()) for x in alerts_raw.split(",") if x.strip()]
            except ValueError as exc:
                raise ValueError("alertThresholds must be a CSV of integers") from exc
        return result


class RuleDialog(_ModalDialog):
    def __init__(self, parent: tk.Widget, initial: dict[str, Any] | None = None):
        super().__init__(parent, title="Admin Rule")
        r = initial or {}
        match = r.get("match") or {}
        action = r.get("action") or {"type": "pin"}

        self.id_var = tk.StringVar(value=r.get("id", ""))
        self.priority_var = tk.StringVar(value=str(r.get("priority", "") or ""))
        self.user_var = tk.StringVar(value=self._csv(match.get("userId")))
        self.org_var = tk.StringVar(value=self._csv(match.get("orgId")))
        self.team_var = tk.StringVar(value=self._csv(match.get("teamId")))
        self.dept_var = tk.StringVar(value=self._csv(match.get("departmentId")))
        self.model_pattern_var = tk.StringVar(value=match.get("modelPattern", ""))
        self.req_priority_var = tk.StringVar(value=match.get("priority", ""))
        self.action_type_var = tk.StringVar(value=action.get("type", "pin"))
        self.pin_model_var = tk.StringVar(value=action.get("model", ""))
        self.strategy_var = tk.StringVar(value=action.get("strategy", "cheapest"))
        self.candidates_var = tk.StringVar(value=", ".join(action.get("candidateModels") or []))
        self.block_reason_var = tk.StringVar(value=action.get("reason", ""))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        rows = [
            ("Rule ID", self.id_var, "entry"),
            ("Priority (optional)", self.priority_var, "entry"),
            ("Match: userId (CSV)", self.user_var, "entry"),
            ("Match: orgId (CSV)", self.org_var, "entry"),
            ("Match: teamId (CSV)", self.team_var, "entry"),
            ("Match: departmentId (CSV)", self.dept_var, "entry"),
            ("Match: modelPattern (glob)", self.model_pattern_var, "entry"),
            ("Match: request priority", self.req_priority_var, ("combo", ["", "realtime", "batch"])),
            ("Action type", self.action_type_var, ("combo", RULE_ACTION_TYPES)),
            ("Pin: model", self.pin_model_var, "entry"),
            ("Strategy: name", self.strategy_var, ("combo", COST_STRATEGIES)),
            ("Strategy: candidate models (CSV)", self.candidates_var, "entry"),
            ("Block: reason", self.block_reason_var, "entry"),
        ]
        for idx, (label, var, kind) in enumerate(rows):
            _grid_label(f, label, idx)
            if kind == "entry":
                _grid_entry(f, var, idx)
            else:
                _, values = kind  # type: ignore[misc]
                _grid_combo(f, var, values, idx)

    @staticmethod
    def _csv(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, list):
            return ", ".join(str(x) for x in value)
        return str(value)

    @staticmethod
    def _csv_to_list(raw: str) -> str | list[str] | None:
        items = [x.strip() for x in raw.split(",") if x.strip()]
        if not items:
            return None
        return items if len(items) > 1 else items[0]

    def collect(self) -> dict[str, Any]:
        rule_id = self.id_var.get().strip()
        if not rule_id:
            raise ValueError("Rule ID is required")
        match: dict[str, Any] = {}
        for key, var in [
            ("userId", self.user_var), ("orgId", self.org_var),
            ("teamId", self.team_var), ("departmentId", self.dept_var),
        ]:
            parsed = self._csv_to_list(var.get())
            if parsed is not None:
                match[key] = parsed
        if self.model_pattern_var.get().strip():
            match["modelPattern"] = self.model_pattern_var.get().strip()
        if self.req_priority_var.get().strip():
            match["priority"] = self.req_priority_var.get().strip()

        atype = self.action_type_var.get()
        if atype == "pin":
            if not self.pin_model_var.get().strip():
                raise ValueError("Pin action requires a model")
            action: dict[str, Any] = {"type": "pin", "model": self.pin_model_var.get().strip()}
        elif atype == "strategy":
            action = {"type": "strategy", "strategy": self.strategy_var.get()}
            candidates = [x.strip() for x in self.candidates_var.get().split(",") if x.strip()]
            if candidates:
                action["candidateModels"] = candidates
        elif atype == "block":
            if not self.block_reason_var.get().strip():
                raise ValueError("Block action requires a reason")
            action = {"type": "block", "reason": self.block_reason_var.get().strip()}
        else:
            raise ValueError(f"Unknown action type: {atype}")

        rule: dict[str, Any] = {"id": rule_id, "match": match, "action": action}
        priority = _safe_int(self.priority_var.get())
        if priority is not None:
            rule["priority"] = priority
        return rule


class PricingDialog(_ModalDialog):
    def __init__(self, parent: tk.Widget, initial: tuple[str, dict[str, float]] | None = None):
        super().__init__(parent, title="Pricing Override")
        model, pricing = initial or ("", {})
        self.model_var = tk.StringVar(value=model)
        self.input_var = tk.StringVar(value=str(pricing.get("input", "")))
        self.output_var = tk.StringVar(value=str(pricing.get("output", "")))
        self.cached_var = tk.StringVar(value=str(pricing.get("cachedInput", "") or ""))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        _grid_label(f, "Model ID", 0); _grid_entry(f, self.model_var, 0)
        _grid_label(f, "input (USD/1M tokens)", 1); _grid_entry(f, self.input_var, 1)
        _grid_label(f, "output (USD/1M tokens)", 2); _grid_entry(f, self.output_var, 2)
        _grid_label(f, "cachedInput (optional)", 3); _grid_entry(f, self.cached_var, 3)

    def collect(self) -> dict[str, Any]:
        model = self.model_var.get().strip()
        if not model:
            raise ValueError("Model ID is required")
        input_price = _safe_float(self.input_var.get())
        output_price = _safe_float(self.output_var.get())
        if input_price is None or output_price is None or input_price < 0 or output_price < 0:
            raise ValueError("input and output prices must be non-negative numbers")
        pricing: dict[str, Any] = {"input": input_price, "output": output_price}
        cached = _safe_float(self.cached_var.get())
        if cached is not None:
            pricing["cachedInput"] = cached
        return {"model": model, "pricing": pricing}


# ── Main app ─────────────────────────────────────────────────────────────

class AdminApp:
    def __init__(
        self,
        root: tk.Tk,
        config_path: str,
        rules_path: str,
        env_path: str,
    ):
        self.root = root
        self.config_path = config_path
        self.rules_path = rules_path
        self.env_path = env_path

        self.config: dict[str, Any] = config_io.load_json(config_path)
        self.rules: list[dict[str, Any]] = config_io.load_rules(rules_path)
        self.env: dict[str, str] = config_io.load_env(env_path)

        self.dirty = False
        self._suspend_dirty = False
        self._reveal_secrets = tk.BooleanVar(value=False)

        root.title(self._title())
        root.geometry("960x680")
        root.minsize(820, 580)

        self._build_menu()
        self._build_notebook()
        self._build_statusbar()
        self._refresh_all()

    # ── chrome ─────────────────────────────────────────────────

    def _title(self) -> str:
        marker = "*" if self.dirty else ""
        return f"FreeRouter Config Manager — {self.config_path}{marker}"

    def _mark_dirty(self, *_args: Any) -> None:
        if self._suspend_dirty:
            return
        self.dirty = True
        self.root.title(self._title())
        self.status_var.set("Unsaved changes")

    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)
        filemenu = tk.Menu(menubar, tearoff=0)
        filemenu.add_command(label="Save", accelerator="Cmd+S", command=self.save_all)
        filemenu.add_command(label="Reload from disk", command=self.reload)
        filemenu.add_separator()
        filemenu.add_command(label="Quit", command=self._on_quit)
        menubar.add_cascade(label="File", menu=filemenu)
        self.root.config(menu=menubar)
        self.root.bind_all("<Command-s>", lambda _e: self.save_all())
        self.root.bind_all("<Control-s>", lambda _e: self.save_all())
        self.root.protocol("WM_DELETE_WINDOW", self._on_quit)

    def _build_notebook(self) -> None:
        nb = ttk.Notebook(self.root)
        nb.pack(fill="both", expand=True, padx=8, pady=(8, 0))
        self.nb = nb
        self._build_general_tab()
        self._build_providers_tab()
        self._build_rate_limit_tab()
        self._build_budgets_tab()
        self._build_rules_tab()
        self._build_pricing_tab()
        self._build_audit_tab()
        self._build_env_tab()

    def _build_statusbar(self) -> None:
        bar = ttk.Frame(self.root, padding=(8, 4))
        bar.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(bar, textvariable=self.status_var).pack(side="left")
        ttk.Button(bar, text="Save", command=self.save_all).pack(side="right")
        ttk.Button(bar, text="Validate", command=self.validate_only).pack(side="right", padx=4)

    # ── tabs ───────────────────────────────────────────────────

    def _build_general_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="General")
        f.columnconfigure(1, weight=1)

        self.default_provider_var = tk.StringVar()
        self.default_model_var = tk.StringVar()
        self.master_key_var = tk.StringVar()
        self.max_input_var = tk.StringVar()
        self.key_expiry_var = tk.StringVar()
        self.guard_var = tk.BooleanVar()
        self.signing_var = tk.BooleanVar()

        for var in (
            self.default_provider_var, self.default_model_var, self.master_key_var,
            self.max_input_var, self.key_expiry_var,
        ):
            var.trace_add("write", self._mark_dirty)
        for bvar in (self.guard_var, self.signing_var):
            bvar.trace_add("write", self._mark_dirty)

        rows = [
            ("Default provider", self.default_provider_var),
            ("Default model", self.default_model_var),
            ("Master key (64-char hex)", self.master_key_var),
            ("Max input length (chars)", self.max_input_var),
            ("Key expiry (ms; blank = never)", self.key_expiry_var),
        ]
        for r, (label, var) in enumerate(rows):
            _grid_label(f, label, r)
            _grid_entry(f, var, r)

        _grid_check(f, "Prompt injection guard", self.guard_var, len(rows))
        _grid_check(f, "Outbound request signing (HMAC-SHA256)", self.signing_var, len(rows) + 1)

    def _build_providers_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Providers")
        f.columnconfigure(1, weight=1)

        self.provider_enabled: dict[str, tk.BooleanVar] = {}
        self.provider_prefixes: dict[str, tk.StringVar] = {}
        ttk.Label(f, text="Enable", width=8).grid(row=0, column=0, padx=8)
        ttk.Label(f, text="Provider").grid(row=0, column=1, sticky="w", padx=8)
        ttk.Label(f, text="Routing prefixes (CSV; blank = defaults)").grid(row=0, column=2, sticky="w", padx=8)
        for r, name in enumerate(KNOWN_PROVIDERS, start=1):
            enabled = tk.BooleanVar(value=True)
            prefixes = tk.StringVar()
            enabled.trace_add("write", self._mark_dirty)
            prefixes.trace_add("write", self._mark_dirty)
            self.provider_enabled[name] = enabled
            self.provider_prefixes[name] = prefixes
            ttk.Checkbutton(f, variable=enabled).grid(row=r, column=0, padx=8, pady=2)
            ttk.Label(f, text=name).grid(row=r, column=1, sticky="w", padx=8)
            ttk.Entry(f, textvariable=prefixes, width=48).grid(row=r, column=2, sticky="ew", padx=8)

        sep_row = len(KNOWN_PROVIDERS) + 2
        ttk.Separator(f, orient="horizontal").grid(row=sep_row, columnspan=3, sticky="ew", pady=12)
        ttk.Label(f, text="Blocked providers (CSV)").grid(row=sep_row + 1, column=0, columnspan=2, sticky="w", padx=8)
        self.blocked_providers_var = tk.StringVar()
        self.blocked_providers_var.trace_add("write", self._mark_dirty)
        ttk.Entry(f, textvariable=self.blocked_providers_var, width=60).grid(
            row=sep_row + 1, column=2, sticky="ew", padx=8
        )
        ttk.Label(f, text="Allowed models (CSV; blank = unrestricted)").grid(
            row=sep_row + 2, column=0, columnspan=2, sticky="w", padx=8
        )
        self.allowed_models_var = tk.StringVar()
        self.allowed_models_var.trace_add("write", self._mark_dirty)
        ttk.Entry(f, textvariable=self.allowed_models_var, width=60).grid(
            row=sep_row + 2, column=2, sticky="ew", padx=8
        )

    def _build_rate_limit_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Rate Limit")
        f.columnconfigure(1, weight=1)
        self.rpm_var = tk.StringVar()
        self.tpm_var = tk.StringVar()
        self.burst_var = tk.StringVar()
        for v in (self.rpm_var, self.tpm_var, self.burst_var):
            v.trace_add("write", self._mark_dirty)
        rows = [
            ("Requests / minute (positive int)", self.rpm_var),
            ("Tokens / minute (optional)", self.tpm_var),
            ("Burst allowance fraction (e.g. 0.2)", self.burst_var),
        ]
        for r, (label, var) in enumerate(rows):
            _grid_label(f, label, r)
            _grid_entry(f, var, r)

    def _build_budgets_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Budgets")
        self.budgets_tree = self._build_table(
            f,
            columns=[("id", 140), ("scope", 160), ("window", 90), ("maxSpendUsd", 120), ("onLimitReached", 130)],
            on_add=self._budget_add,
            on_edit=self._budget_edit,
            on_delete=self._budget_delete,
        )

    def _build_rules_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Rules")
        self.rules_tree = self._build_table(
            f,
            columns=[("id", 140), ("priority", 80), ("match", 220), ("action", 220)],
            on_add=self._rule_add,
            on_edit=self._rule_edit,
            on_delete=self._rule_delete,
        )

    def _build_pricing_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Pricing Overrides")
        self.pricing_tree = self._build_table(
            f,
            columns=[("model", 220), ("input", 120), ("output", 120), ("cachedInput", 120)],
            on_add=self._pricing_add,
            on_edit=self._pricing_edit,
            on_delete=self._pricing_delete,
        )

    def _build_audit_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Audit")
        self.audit_enabled_var = tk.BooleanVar()
        self.audit_enabled_var.trace_add("write", self._mark_dirty)
        _grid_check(f, "Enable audit logging", self.audit_enabled_var, 0, col=0)
        ttk.Label(
            f,
            text=(
                "Audit sinks (file/HTTP/etc.) are wired in code at runtime — set\n"
                "`audit.sink` when constructing the FreeRouter instance. This\n"
                "checkbox toggles the `audit.enabled` flag in the config file."
            ),
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=8, pady=8)

    def _build_env_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Env Vars")
        f.columnconfigure(1, weight=1)
        ttk.Label(
            f,
            text=f"Editing {self.env_path} (relative to CWD). Values are masked unless reveal is on.",
            foreground="#555",
        ).grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 8))

        self.env_vars: dict[str, tk.StringVar] = {}
        self.env_entries: dict[str, ttk.Entry] = {}
        for r, (key, desc) in enumerate(KNOWN_ENV_VARS, start=1):
            _grid_label(f, key, r)
            var = tk.StringVar()
            var.trace_add("write", self._mark_dirty)
            self.env_vars[key] = var
            entry = ttk.Entry(f, textvariable=var, width=48, show="•")
            entry.grid(row=r, column=1, sticky="ew", padx=8, pady=2)
            self.env_entries[key] = entry
            ttk.Label(f, text=desc, foreground="#666").grid(row=r, column=2, sticky="w", padx=8)

        reveal_row = len(KNOWN_ENV_VARS) + 2
        ttk.Checkbutton(
            f, text="Reveal values", variable=self._reveal_secrets, command=self._toggle_secret_reveal
        ).grid(row=reveal_row, column=0, columnspan=2, sticky="w", padx=8, pady=8)

    def _toggle_secret_reveal(self) -> None:
        show = "" if self._reveal_secrets.get() else "•"
        for entry in self.env_entries.values():
            entry.configure(show=show)

    # ── reusable table builder ─────────────────────────────────

    def _build_table(
        self,
        parent: tk.Widget,
        columns: list[tuple[str, int]],
        on_add: Callable[[], None],
        on_edit: Callable[[], None],
        on_delete: Callable[[], None],
    ) -> ttk.Treeview:
        parent.rowconfigure(0, weight=1)
        parent.columnconfigure(0, weight=1)
        col_ids = [c[0] for c in columns]
        tree = ttk.Treeview(parent, columns=col_ids, show="headings", height=14)
        for cid, width in columns:
            tree.heading(cid, text=cid)
            tree.column(cid, width=width, anchor="w")
        tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(parent, orient="vertical", command=tree.yview)
        sb.grid(row=0, column=1, sticky="ns")
        tree.configure(yscrollcommand=sb.set)

        btns = ttk.Frame(parent)
        btns.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        ttk.Button(btns, text="Add", command=on_add).pack(side="left")
        ttk.Button(btns, text="Edit", command=on_edit).pack(side="left", padx=4)
        ttk.Button(btns, text="Delete", command=on_delete).pack(side="left")
        tree.bind("<Double-1>", lambda _e: on_edit())
        return tree

    # ── budgets CRUD ──────────────────────────────────────────

    def _budgets_list(self) -> list[dict[str, Any]]:
        return list(self.config.get("budgets") or [])

    def _budget_add(self) -> None:
        dlg = BudgetDialog(self.root)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        budgets = self._budgets_list()
        if any(b.get("id") == dlg.result["id"] for b in budgets):
            messagebox.showerror("Duplicate", f"Budget id '{dlg.result['id']}' already exists.")
            return
        budgets.append(dlg.result)
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._mark_dirty()

    def _budget_edit(self) -> None:
        sel = self._selected_index(self.budgets_tree)
        if sel is None:
            return
        budgets = self._budgets_list()
        dlg = BudgetDialog(self.root, initial=budgets[sel])
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        budgets[sel] = dlg.result
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._mark_dirty()

    def _budget_delete(self) -> None:
        sel = self._selected_index(self.budgets_tree)
        if sel is None:
            return
        budgets = self._budgets_list()
        budgets.pop(sel)
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._mark_dirty()

    def _refresh_budgets_tree(self) -> None:
        self.budgets_tree.delete(*self.budgets_tree.get_children())
        for b in self._budgets_list():
            scope = b.get("scope") or {}
            scope_label = scope.get("type", "?")
            for f in ("orgId", "departmentId", "teamId", "userId"):
                if scope.get(f):
                    scope_label += f"/{scope[f]}"
            self.budgets_tree.insert("", "end", values=(
                b.get("id", ""), scope_label, b.get("window", ""),
                b.get("maxSpendUsd", ""), b.get("onLimitReached", ""),
            ))

    # ── rules CRUD ────────────────────────────────────────────

    def _rule_add(self) -> None:
        dlg = RuleDialog(self.root)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        if any(r.get("id") == dlg.result["id"] for r in self.rules):
            messagebox.showerror("Duplicate", f"Rule id '{dlg.result['id']}' already exists.")
            return
        self.rules.append(dlg.result)
        self._refresh_rules_tree()
        self._mark_dirty()

    def _rule_edit(self) -> None:
        sel = self._selected_index(self.rules_tree)
        if sel is None:
            return
        dlg = RuleDialog(self.root, initial=self.rules[sel])
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        self.rules[sel] = dlg.result
        self._refresh_rules_tree()
        self._mark_dirty()

    def _rule_delete(self) -> None:
        sel = self._selected_index(self.rules_tree)
        if sel is None:
            return
        self.rules.pop(sel)
        self._refresh_rules_tree()
        self._mark_dirty()

    def _refresh_rules_tree(self) -> None:
        self.rules_tree.delete(*self.rules_tree.get_children())
        for r in self.rules:
            match = r.get("match") or {}
            action = r.get("action") or {}
            match_label = ", ".join(f"{k}={v}" for k, v in match.items()) or "(any)"
            action_label = action.get("type", "?")
            if action_label == "pin":
                action_label += f" → {action.get('model', '')}"
            elif action_label == "strategy":
                action_label += f" → {action.get('strategy', '')}"
            elif action_label == "block":
                action_label += f" ({action.get('reason', '')})"
            self.rules_tree.insert("", "end", values=(
                r.get("id", ""), r.get("priority", ""), match_label, action_label,
            ))

    # ── pricing CRUD ──────────────────────────────────────────

    def _pricing_dict(self) -> dict[str, dict[str, float]]:
        return self.config.setdefault("pricingOverrides", {})

    def _pricing_add(self) -> None:
        dlg = PricingDialog(self.root)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        overrides = self._pricing_dict()
        if dlg.result["model"] in overrides:
            messagebox.showerror("Duplicate", f"Override for '{dlg.result['model']}' already exists.")
            return
        overrides[dlg.result["model"]] = dlg.result["pricing"]
        self._refresh_pricing_tree()
        self._mark_dirty()

    def _pricing_edit(self) -> None:
        sel = self._selected_index(self.pricing_tree)
        if sel is None:
            return
        items = list(self._pricing_dict().items())
        model, pricing = items[sel]
        dlg = PricingDialog(self.root, initial=(model, pricing))
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        overrides = self._pricing_dict()
        if dlg.result["model"] != model:
            del overrides[model]
        overrides[dlg.result["model"]] = dlg.result["pricing"]
        self._refresh_pricing_tree()
        self._mark_dirty()

    def _pricing_delete(self) -> None:
        sel = self._selected_index(self.pricing_tree)
        if sel is None:
            return
        items = list(self._pricing_dict().items())
        model, _ = items[sel]
        del self._pricing_dict()[model]
        self._refresh_pricing_tree()
        self._mark_dirty()

    def _refresh_pricing_tree(self) -> None:
        self.pricing_tree.delete(*self.pricing_tree.get_children())
        for model, pricing in self._pricing_dict().items():
            self.pricing_tree.insert("", "end", values=(
                model, pricing.get("input", ""), pricing.get("output", ""),
                pricing.get("cachedInput", ""),
            ))

    # ── selection helpers ─────────────────────────────────────

    def _selected_index(self, tree: ttk.Treeview) -> int | None:
        sel = tree.selection()
        if not sel:
            messagebox.showinfo("No selection", "Select a row first.")
            return None
        return tree.index(sel[0])

    # ── load / save ───────────────────────────────────────────

    def _refresh_all(self) -> None:
        self._suspend_dirty = True
        try:
            cfg = self.config
            self.default_provider_var.set(cfg.get("defaultProvider", "") or "")
            self.default_model_var.set(cfg.get("defaultModel", "") or "")
            self.master_key_var.set(cfg.get("masterKey", "") or "")
            self.max_input_var.set(str(cfg.get("maxInputLength", "") or ""))
            self.key_expiry_var.set(str(cfg.get("keyExpiryMs", "") or ""))
            self.guard_var.set(bool(cfg.get("promptInjectionGuard", True)))
            self.signing_var.set(bool(cfg.get("requestSigning", False)))

            providers = cfg.get("providers") or {}
            for name in KNOWN_PROVIDERS:
                p = providers.get(name) or {}
                self.provider_enabled[name].set(bool(p.get("enabled", True)))
                self.provider_prefixes[name].set(", ".join(p.get("routingPrefixes") or []))
            self.blocked_providers_var.set(", ".join(cfg.get("blockedProviders") or []))
            self.allowed_models_var.set(", ".join(cfg.get("allowedModels") or []))

            rl = cfg.get("rateLimit") or {}
            self.rpm_var.set(str(rl.get("requestsPerMinute", "") or ""))
            self.tpm_var.set(str(rl.get("tokensPerMinute", "") or ""))
            self.burst_var.set(str(rl.get("burstAllowance", "") or ""))

            audit = cfg.get("audit") or {}
            self.audit_enabled_var.set(bool(audit.get("enabled", False)))

            for key, var in self.env_vars.items():
                var.set(self.env.get(key, ""))

            self._refresh_budgets_tree()
            self._refresh_rules_tree()
            self._refresh_pricing_tree()
            self.dirty = False
            self.root.title(self._title())
            self.status_var.set("Ready")
        finally:
            self._suspend_dirty = False

    def _gather_into_config(self) -> dict[str, Any]:
        cfg = deepcopy(self.config)

        cfg["defaultProvider"] = _empty_to_none(self.default_provider_var.get())
        cfg["defaultModel"] = _empty_to_none(self.default_model_var.get())
        if not cfg["defaultProvider"]:
            cfg.pop("defaultProvider", None)
        if not cfg["defaultModel"]:
            cfg.pop("defaultModel", None)

        master_key = _empty_to_none(self.master_key_var.get())
        if master_key:
            cfg["masterKey"] = master_key
        else:
            cfg.pop("masterKey", None)

        max_input = _safe_int(self.max_input_var.get())
        if max_input is not None:
            cfg["maxInputLength"] = max_input
        else:
            cfg.pop("maxInputLength", None)

        key_expiry = _safe_int(self.key_expiry_var.get())
        if key_expiry is not None:
            cfg["keyExpiryMs"] = key_expiry
        else:
            cfg.pop("keyExpiryMs", None)

        cfg["promptInjectionGuard"] = self.guard_var.get()
        cfg["requestSigning"] = self.signing_var.get()

        providers: dict[str, Any] = {}
        for name in KNOWN_PROVIDERS:
            entry: dict[str, Any] = {"enabled": self.provider_enabled[name].get()}
            prefixes = [p.strip() for p in self.provider_prefixes[name].get().split(",") if p.strip()]
            if prefixes:
                entry["routingPrefixes"] = prefixes
            providers[name] = entry
        cfg["providers"] = providers

        blocked = [p.strip() for p in self.blocked_providers_var.get().split(",") if p.strip()]
        if blocked:
            cfg["blockedProviders"] = blocked
        else:
            cfg.pop("blockedProviders", None)
        allowed = [m.strip() for m in self.allowed_models_var.get().split(",") if m.strip()]
        if allowed:
            cfg["allowedModels"] = allowed
        else:
            cfg.pop("allowedModels", None)

        rpm = _safe_int(self.rpm_var.get())
        tpm = _safe_float(self.tpm_var.get())
        burst = _safe_float(self.burst_var.get())
        if rpm is not None or tpm is not None or burst is not None:
            rl: dict[str, Any] = {}
            if rpm is not None:
                rl["requestsPerMinute"] = rpm
            if tpm is not None:
                rl["tokensPerMinute"] = tpm
            if burst is not None:
                rl["burstAllowance"] = burst
            cfg["rateLimit"] = rl
        else:
            cfg.pop("rateLimit", None)

        cfg["audit"] = {"enabled": self.audit_enabled_var.get()}
        return cfg

    def validate_only(self) -> bool:
        cfg = self._gather_into_config()
        cfg_result = validate_config(cfg)
        rules_result = validate_rules(self.rules)

        problems: list[str] = list(cfg_result.errors) + list(rules_result.errors)
        warnings: list[str] = list(cfg_result.warnings) + list(rules_result.warnings)

        if problems:
            messagebox.showerror(
                "Validation failed",
                "Fix these errors before saving:\n\n" + "\n".join(f"• {p}" for p in problems),
            )
            return False
        if warnings:
            messagebox.showwarning(
                "Validation warnings",
                "Config is valid but has warnings:\n\n" + "\n".join(f"• {w}" for w in warnings),
            )
        else:
            messagebox.showinfo("Validation", "Config and rules are valid.")
        return True

    def save_all(self) -> None:
        cfg = self._gather_into_config()
        cfg_result = validate_config(cfg)
        rules_result = validate_rules(self.rules)
        problems: list[str] = list(cfg_result.errors) + list(rules_result.errors)
        if problems:
            messagebox.showerror(
                "Cannot save",
                "Fix these errors before saving:\n\n" + "\n".join(f"• {p}" for p in problems),
            )
            return

        env_out = {k: v.get() for k, v in self.env_vars.items() if v.get().strip()}

        try:
            config_io.save_json(self.config_path, cfg)
            config_io.save_rules(self.rules_path, self.rules)
            config_io.save_env(self.env_path, env_out)
        except OSError as exc:
            messagebox.showerror("Save failed", f"{exc}")
            return

        self.config = cfg
        self.env = env_out
        self.dirty = False
        self.root.title(self._title())
        self.status_var.set(
            f"Saved {self.config_path}, {self.rules_path}, {self.env_path}"
        )

    def reload(self) -> None:
        if self.dirty and not messagebox.askyesno(
            "Discard changes?", "Reloading will discard your unsaved edits. Continue?"
        ):
            return
        self.config = config_io.load_json(self.config_path)
        self.rules = config_io.load_rules(self.rules_path)
        self.env = config_io.load_env(self.env_path)
        self._refresh_all()
        self.status_var.set("Reloaded from disk")

    def _on_quit(self) -> None:
        if self.dirty and not messagebox.askyesno(
            "Quit without saving?", "You have unsaved changes. Quit anyway?"
        ):
            return
        self.root.destroy()
