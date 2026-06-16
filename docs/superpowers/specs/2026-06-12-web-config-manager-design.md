# Web Config Manager — Design

Date: 2026-06-12
Status: Approved (pending spec review)

## Problem

FinRouter ships with an optional, standalone operator tool — `config-manager/`
— a ~2,100-line Tkinter desktop app (plus stdlib-only Python modules:
`config_io`, `byok_io`, `pricing_fetcher`, `candidates_io`, `validators`,
`auth`, `prefs`). It edits a single FinRouter deployment's `config`, `rules`,
and `.env` files on the local filesystem, gated by a one-time admin key. It is
not published in the npm package.

We are replacing it with a **deployed, multi-user, web-based** configuration
manager. The web manager is a separate application that lives beside the repo
(like the Python tool did) and is never published in the npm `dist/`. After the
web manager is implemented, tested, and verified working, the Python
`config-manager/` is deleted.

## Goals / Non-goals

**Goals**
- Full feature parity with the Python tool's ten sections plus the
  auto-optimization candidates panel.
- Multi-user access with OIDC SSO and role-based access control.
- Manage multiple named environments (e.g. dev/staging/prod), each with its own
  file set.
- Concurrency-safe editing of server-side config files (optimistic locking).
- Secure BYOK handling: write-only encrypted local storage **plus** pluggable
  external key-manager backends.
- Accenture light visual theme.
- Reuse FinRouter's own validation, pricing sources, and optimization types
  rather than reimplementing them.

**Non-goals**
- Editing FinRouter source or runtime behavior.
- A database-backed config store (we keep the file model FinRouter consumes).
- Revealing stored secrets through the browser.
- Backward compatibility with the Python tool's admin-key auth (replaced by
  OIDC).

## Tech stack

- **Backend:** Node + TypeScript, **Fastify** (swappable). Depends on the
  published `finrouter` package for `validateConfig` / `validateConfigKeys`,
  `HttpPricingSource` + LiteLLM/OpenRouter transforms, and the
  optimization/optimized-store types.
- **Frontend:** React + Vite + TypeScript SPA.
- **Auth:** `openid-client` (OIDC).
- **Tests:** Vitest (server + frontend unit), Playwright (a few e2e).

## Placement

```
config-manager-web/
  server/        # Fastify API (TS)
  web/           # React + Vite SPA (TS)
  README.md
config-manager/  # Python tool — retained during build, DELETED after the
                 # web manager is tested and verified working.
```

Neither directory is included in the npm package (`package.json` publishes only
`dist/`). The web manager is deployed independently.

## Architecture

```
browser ──HTTPS──> Fastify API (session-guarded, RBAC)
                     ├─ OIDC auth (openid-client)
                     ├─ Environment repo (per-env files, optimistic lock)
                     ├─ Validation  → finrouter validateConfig/validateConfigKeys
                     ├─ Pricing fetch → finrouter HttpPricingSource (LiteLLM/OpenRouter)
                     ├─ BYOK backends (local-encrypted | vault | aws | azure | gcp)
                     ├─ Candidates → GEPA sidecar /optimize (server-side)
                     └─ Audit log (append-only)
```

Pricing fetch and candidate optimization run server-side so sidecar URLs/tokens
and pricing-source calls never reach the browser and CORS is avoided.

## Components

### 1. Authentication (OIDC)

- `openid-client`-based authorization-code flow: `/auth/login` → IdP →
  `/auth/callback` → signed **httpOnly, Secure, SameSite=Lax** session cookie.
  `/auth/logout` clears it.
- The session stores the OIDC subject, display name, and the user's group
  claims. Sessions are signed with a server secret; expiry is configurable.
- Configuration (server env): issuer URL, client id/secret, redirect URL,
  scopes, and the **claim** that carries groups.

### 2. RBAC

- Two roles: `admin` (read + write) and `viewer` (read-only).
- A server-side mapping resolves IdP groups → roles, with **per-environment
  overrides** (a group may be `admin` on `dev`, `viewer` on `prod`).
- Middleware guards: authenticated for all routes; `admin` required for every
  mutating route, evaluated against the **active environment**.
- The frontend renders read-only controls for `viewer` and hides mutating
  actions, but the server is the source of truth (never trusts the client).

### 3. Environments

- `environments.json` (server-side) defines named environments. Each entry:
  ```jsonc
  {
    "id": "prod",
    "label": "Production",
    "paths": {
      "config": "/etc/finrouter/prod/finrouter.config.json",
      "rules": "/etc/finrouter/prod/finrouter.rules.json",
      "env": "/etc/finrouter/prod/.env",
      "pricing": "/etc/finrouter/prod/pricing.json",
      "optimizedStore": "/etc/finrouter/prod/optimized-prompts.json",
      "candidates": "/etc/finrouter/prod/candidates.json"
    }
  }
  ```
- The UI header has an environment switcher. The active environment scopes every
  read/write and is checked against the user's per-env role.

### 4. Config store & concurrency

- A per-environment file repository: atomic writes (tmp + rename, mirroring the
  Python `config_io`).
- Reads return `{ data, version }` where `version` is a SHA-256 of the
  on-disk bytes.
- Writes must include the `version` they edited. If it no longer matches disk,
  the API returns **409 Conflict**; the UI shows a "changed underneath you —
  reload" banner. No database required.

### 5. Validation

- Reuse `finrouter`'s exported `validateConfig` and `validateConfigKeys` for
  config; reuse the rules/budget validation shapes. Add web-specific request
  schema validation (Fastify JSON schema) at the API boundary.
- Validation failures return **422** with field-level messages the UI renders
  inline.

### 6. Pricing fetch

- Server-side endpoint that uses `finrouter`'s `HttpPricingSource` with the
  LiteLLM and OpenRouter transforms (already exported by the library) to fetch a
  pricing manifest, filtered to configured providers, and returns it for the
  Pricing Overrides view to apply. Mirrors the Python `pricing_fetcher` behavior
  using the library's own implementation.

### 7. BYOK with pluggable key-manager backends

- A `KeyBackend` interface:
  ```ts
  interface KeyBackend {
    set(provider: string, secret: string, ref?: string): Promise<KeyRef>
    rotate(provider: string, secret: string): Promise<KeyRef>
    delete(provider: string): Promise<void>
    describe(provider: string): Promise<{ isSet: boolean; last4?: string; ref?: string }>
  }
  ```
- Implementations:
  - **`local`** — AES-256-GCM encrypted at rest; master key from server env/KMS.
    Stores ciphertext. **Write-only; plaintext is never returned to any browser.**
  - **`vault`** (HashiCorp Vault), **`aws-secrets-manager`**,
    **`azure-key-vault`**, **`gcp-secret-manager`** — the manager stores only a
    **reference** (path/ARN/secret name), never the secret. It can optionally
    write a provided secret into the manager when granted, and validates that the
    reference resolves.
- Each provider's BYOK entry records `{ provider, backend, ref, isSet, last4? }`.
  The API exposes set / rotate / delete / describe only — never a read of the
  secret. Admin-only. Runtime resolution of the key remains FinRouter's concern;
  the manager records and validates the reference.

### 8. Auto-optimization candidates

- Server-side port of `candidates_io`: read the active environment's
  `candidates.json`, call the GEPA sidecar `/optimize` (sidecar URL/token held
  server-side), write the optimized-prompt store, and update candidate statuses.
  Reuses the `OptimizedEntry` / `CandidateEntry` types from `finrouter`.

### 9. Audit log

- Every mutating action — config save, key set/rotate/delete, candidate
  optimize, environment change — is appended to a per-deployment audit store
  (JSONL file) with `{ subject, timestamp, environment, action, target,
  beforeHash, afterHash }`. Surfaced in the Audit view. Distinct from
  FinRouter's own request-level audit trail.

### 10. Frontend (React + Vite + TS)

- App shell: header with environment switcher + signed-in user + sign-out; left
  nav listing the sections; main content area.
- Sections (parity with the Python tabs): General, Providers, Rate Limit,
  Budgets, Rules, Pricing Overrides, BYOK Keys (+ key-manager backends),
  Optimization (incl. the auto-optimization candidates panel), Audit, Env Vars.
- Dialogs as modals: Budget, Rule, Pricing, BYOK, FetchPricing.
- A small shared, Accenture-themed component kit: inputs, selects, tables,
  modals, toasts, the env switcher.
- Optimistic-version handling: edits carry the `version`; a 409 shows a conflict
  banner with reload.
- Role-aware rendering: `viewer` sees read-only controls; mutating actions are
  hidden (server still enforces).

### Theming (Accenture light)

CSS custom properties:
- surfaces: white `#FFFFFF`, secondary `#F2F2F2`
- text: `#1A1A1A`
- primary / active / links: Accenture purple `#A100FF`
- accessible focus/hover states (visible focus ring; AA contrast)

## Data flow

1. Browser loads SPA → calls `/auth/me`; if unauthenticated → `/auth/login`.
2. Authenticated requests carry the session cookie; the server resolves
   role for the active environment.
3. Read: `GET /api/env/:id/config` → `{ data, version }`.
4. Edit + save: `PUT /api/env/:id/config` with `{ data, version }` →
   validate → atomic write → audit → new `version` (or 409 / 422).
5. BYOK / pricing-fetch / candidate-optimize: dedicated server-side endpoints,
   admin-guarded, audited.

## Error handling

- **401** (no/expired session) → SPA redirects to login.
- **403** (role) → forbidden view; mutating controls already hidden.
- **409** (stale version) → conflict banner, offer reload.
- **422** (validation) → inline field errors from `validateConfig`.
- Upstream failures (sidecar, key manager, pricing source) → surfaced
  non-fatally with the underlying cause; the edited state is preserved.

## Testing

**Server (Vitest):**
- Environment repo: atomic write, version hashing, optimistic-lock 409.
- Validation reuse: invalid config → 422 with field messages.
- BYOK: `local` crypto round-trip (encrypt/describe/rotate/delete, never returns
  plaintext); external backends against mocked SDKs (reference stored, resolve
  validated).
- Pricing fetch: LiteLLM/OpenRouter transforms via the library, provider filter.
- Candidates: read → mocked sidecar `/optimize` → optimized store written →
  status updated.
- Auth: OIDC middleware with a mock IdP (valid/expired/invalid session).
- RBAC: admin vs viewer vs per-env override on mutating routes.
- Audit: each mutating action appends a correct record.

**Frontend (Vitest + Testing Library):**
- Key forms/dialogs (Budget, Rule, Pricing, BYOK) validate and submit.
- Conflict (409) banner behavior.
- Role-aware rendering (viewer read-only).

**E2E (Playwright):**
- Login (mock IdP) → edit General → save → reload shows persisted value.
- Concurrent edit → second save gets the conflict banner.
- BYOK set (local backend) → describe shows `isSet` + `last4`, never plaintext.
- Candidate optimize (mock sidecar) → status flips to optimized.

## Decommissioning the Python tool

The Python `config-manager/` is retained while the web manager is built and
tested. As the final step — **after** the web manager's test suites pass and the
feature is verified working — the `config-manager/` directory and its references
(README/docs pointers) are deleted in a dedicated commit.

## Out of scope / future

- Database-backed config store and config version history beyond the audit log.
- Built-in user management (delegated to the IdP).
- Editing more than one FinRouter deployment's files per environment entry.
