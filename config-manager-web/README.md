# FreeRouter Web Config Manager

Deployed, multi-user web manager for FreeRouter configuration. Replaces the
Python `config-manager/`. Not published in the npm package.

- `server/` — Fastify + TypeScript API (OIDC auth, RBAC, per-environment file
  store with optimistic locking, audit log).
- `web/` — React + Vite SPA (Accenture light theme).

## Develop

```bash
npm install
npm run dev:server   # API on :7700
npm run dev:web      # Vite dev server on :5173 (proxies /api,/auth to :7700)
npm test
```

See `docs/superpowers/specs/2026-06-12-web-config-manager-design.md`.
