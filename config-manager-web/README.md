# FreeRouter Web Config Manager

Deployed, multi-user web manager for FreeRouter configuration. Replaces the
Python `config-manager/`. Not published in the npm package.

- `server/` — Fastify + TypeScript API (OIDC auth, RBAC, per-environment file
  store with optimistic locking, audit log).
- `web/` — React + Vite SPA (Accenture light theme).

## Develop (local, zero config)

`npm run dev:server` runs in **dev mode** (`FR_ADMIN_DEV=1`): no OIDC provider and
no required env vars — it auto-logs you in as a "Dev Admin" and stores config
under `./.dev-data/`. This is for local exploration only; it has **no real
authentication**.

```bash
npm install
npm run dev:server   # API on :7700 (dev mode: auto-login, ./.dev-data/)
npm run dev:web      # Vite on :5173, proxies /api,/auth to :7700 — open this
npm test
```

Open http://localhost:5173 — the SPA redirects through the fake login and lands
you in the app as Dev Admin (role: admin) on a "Development" environment.

Optional dev env vars: `PORT`, `FR_ADMIN_DEV_DATA` (data dir),
`FR_ADMIN_DEV_ORIGIN` (browser origin; default `http://localhost:5173`),
`BYOK_MASTER_KEY` (32-byte hex; a dev default is used otherwise).

## Run for real (production)

A real deployment requires OIDC + session config and serves the built SPA from
the server (single origin). Build, then start with the env vars set:

```bash
npm run build        # builds server (dist/) and web (web/dist/)
OIDC_ISSUER=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... \
OIDC_REDIRECT_URI=https://admin.example.com/auth/callback \
SESSION_SECRET=$(openssl rand -hex 32) \
ENVIRONMENTS_FILE=/etc/freerouter/environments.json \
ROLE_MAPPING_FILE=/etc/freerouter/role-mapping.json \
AUDIT_LOG_FILE=/var/log/fr-admin-audit.jsonl \
BYOK_MASTER_KEY=$(openssl rand -hex 32) \
WEB_DIST_DIR="$(pwd)/web/dist" \
npm run --workspace server start
```

Optional: `GEPA_SIDECAR_URL`/`GEPA_SIDECAR_TOKEN` (candidates optimize),
`VAULT_ADDR`/`VAULT_TOKEN` (Vault BYOK backend).

See `docs/superpowers/specs/2026-06-12-web-config-manager-design.md`.
