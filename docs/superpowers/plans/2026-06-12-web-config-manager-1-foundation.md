# Web Config Manager — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `config-manager-web` app as a complete, testable vertical slice — Fastify/TS backend with OIDC auth, RBAC, a multi-environment file store with optimistic locking, config validation (reusing the `freerouter` package), and an append-only audit log; plus a React/Vite/TS frontend with the Accenture light theme, an auth gate, an environment switcher, and working General + Providers sections.

**Architecture:** A separate app under `config-manager-web/` (npm workspaces: `server/` + `web/`), never published in the FreeRouter npm package. The server is a Fastify API that reads/writes per-environment FreeRouter config files on disk with content-hash optimistic locking, guarded by OIDC sessions and per-environment RBAC, recording every mutation to an audit log. The frontend is a React SPA that talks to the API and renders the config as themed forms. Validation reuses `freerouter`'s exported `validateConfig` / `validateConfigKeys`.

**Tech Stack:** Node ≥20, TypeScript (ESM/NodeNext), Fastify 4, `@fastify/secure-session`, `@fastify/cookie`, `openid-client` 5, React 18, Vite 5, Vitest, `@testing-library/react`, `freerouter` (via `file:../..`).

This is **Plan 1 of a sequence**. Later plans add the remaining config sections, BYOK + key-manager backends, pricing-fetch + candidates + audit view, e2e, and the deletion of the Python `config-manager/`. Do not implement those here.

---

## File Structure

```
config-manager-web/
  package.json                      # npm workspaces root (server, web)
  .gitignore
  README.md
  server/
    package.json                    # Fastify API; depends on freerouter (file:../..)
    tsconfig.json
    vitest.config.ts
    src/
      types.ts                      # shared server types (Role, Environment, Session, etc.)
      config.ts                     # server env-var config loader (issuer, secrets, paths)
      environments.ts               # environments.json loader + EnvironmentRegistry
      store/
        config-store.ts             # per-env file repo: read {data,version}, write w/ optimistic lock
        audit-log.ts                # append-only JSONL audit writer/reader
      validation.ts                 # wraps freerouter validateConfig/validateConfigKeys -> 422 shape
      auth/
        oidc.ts                     # OidcProvider interface + openid-client impl
        rbac.ts                     # groups->roles mapping w/ per-env overrides + resolveRole
      app.ts                        # buildApp(deps): Fastify instance, plugins, routes
      routes/
        auth-routes.ts              # /auth/login, /auth/callback, /auth/logout, /auth/me
        config-routes.ts            # /api/env, /api/env/:id/config GET+PUT
      server.ts                     # entrypoint: load config, build app, listen
    test/
      config-store.test.ts
      audit-log.test.ts
      validation.test.ts
      rbac.test.ts
      auth-routes.test.ts
      config-routes.test.ts
      helpers.ts                    # buildTestApp() with a fake OidcProvider + temp env files
  web/
    package.json                    # React + Vite SPA
    tsconfig.json
    vite.config.ts
    vitest.config.ts
    index.html
    src/
      main.tsx                      # React entry
      theme.css                     # Accenture light theme tokens (CSS variables)
      api.ts                        # typed fetch client (handles 401/409/422)
      types.ts                      # shared client types mirroring server DTOs
      auth/AuthGate.tsx             # gates the app on /auth/me; login redirect
      app/AppShell.tsx              # header (env switcher, user, sign-out) + nav + outlet
      app/EnvSwitcher.tsx           # environment dropdown
      app/useConfig.ts              # hook: load {data,version}, save with version, conflict state
      sections/GeneralSection.tsx   # edit defaultProvider/defaultModel/maxInputLength/etc.
      sections/ProvidersSection.tsx # toggle providers enabled/disabled
      components/                   # Field, TextInput, Toggle, Button, Toast, ConflictBanner
        Field.tsx
        TextInput.tsx
        Toggle.tsx
        Button.tsx
        Toast.tsx
        ConflictBanner.tsx
    test/
      api.test.ts
      GeneralSection.test.tsx
      ProvidersSection.test.tsx
      setup.ts                      # jsdom + testing-library setup
```

Run all commands from `config-manager-web/` unless a task says otherwise.

---

## Task 0: Reconcile core config key-lists (FreeRouter core — prerequisite)

The web manager reuses `freerouter`'s `validateConfigKeys` (config-loader) and
`validateConfig` (config-validator). Both maintain a hardcoded set of known
top-level keys, and both are **incomplete** relative to `RouterConfig`:

- `config-loader.ts` `KNOWN_KEYS` is missing: `spendPersistence`,
  `costOptimization`, `pricingRefresh`, `rules`, `rulesRefresh`. Because the web
  manager surfaces `validateConfigKeys` output as **422 errors**, valid configs
  using those keys would be wrongly rejected.
- `config-validator.ts` `KNOWN_TOP_LEVEL_KEYS` is missing more
  (`telemetryExport`, `shadowRouter`, `promptOptimization`, `autoOptimization`,
  `costOptimization`, `pricingRefresh`, `rules`, `rulesRefresh`,
  `onPricingRefreshed`, `onRulesRefreshed`). `validateConfig` only **warns** on
  unknown keys (they go to `warnings`, not `errors`, so `valid` is unaffected),
  so this produces spurious "possible typo" warnings rather than rejections —
  still worth fixing.

This task runs in the **FreeRouter core** (repo root
`/Users/rajat.a.ahuja/Dev/FreeRouter`), not in `config-manager-web/`.

**Files:**
- Modify: `src/config-loader.ts` (the `KNOWN_KEYS` set)
- Modify: `src/config-validator.ts` (the `KNOWN_TOP_LEVEL_KEYS` set)
- Test: `tests/config-loader.test.ts` (add cases), `tests/config-validator.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Append to `tests/config-loader.test.ts` (it already imports `validateConfigKeys`; if not, add `import { validateConfigKeys } from '../src/config-loader.js'`):

```ts
describe('validateConfigKeys — full RouterConfig key coverage', () => {
  it('accepts all file-loadable RouterConfig top-level keys', () => {
    const cfg = {
      masterKey: 'x', defaultProvider: 'g', defaultModel: 'm', keyExpiryMs: 1,
      maxInputLength: 1, promptInjectionGuard: true, requestSigning: true,
      blockedProviders: [], allowedModels: [], rateLimit: {}, budgets: [],
      providers: {}, audit: {}, pricingOverrides: {},
      spendPersistence: {}, telemetryExport: {}, shadowRouter: {},
      promptOptimization: {}, autoOptimization: {}, costOptimization: {},
      pricingRefresh: {}, rules: {}, rulesRefresh: {},
    }
    expect(validateConfigKeys(cfg)).toEqual([])
  })
})
```

Create `tests/config-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateConfig } from '../src/config-validator.js'

describe('validateConfig — known-key coverage', () => {
  it('emits no "possible typo" warnings for documented RouterConfig keys', () => {
    const cfg = {
      spendPersistence: {}, telemetryExport: {}, shadowRouter: {},
      promptOptimization: {}, autoOptimization: { enabled: true },
      costOptimization: {}, pricingRefresh: {}, rules: {}, rulesRefresh: {},
    }
    const result = validateConfig(cfg)
    expect(result.valid).toBe(true)
    expect(result.warnings.filter(w => /possible typo/.test(w))).toEqual([])
  })

  it('still flags a genuinely unknown key as a warning', () => {
    const result = validateConfig({ totallyBogusKey: 1 })
    expect(result.warnings.some(w => /totallyBogusKey/.test(w))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from repo root): `npx vitest run tests/config-loader.test.ts tests/config-validator.test.ts`
Expected: FAIL — `validateConfigKeys` returns the missing keys (e.g. `costOptimization`); the validator test reports "possible typo" warnings for documented keys.

- [ ] **Step 3: Fix `src/config-loader.ts` `KNOWN_KEYS`**

Replace the `KNOWN_KEYS` set with the complete file-loadable set (callbacks are
excluded — they can't appear in a file config):

```ts
const KNOWN_KEYS = new Set<string>([
  'defaultProvider', 'defaultModel', 'masterKey', 'keyExpiryMs',
  'maxInputLength', 'promptInjectionGuard', 'requestSigning',
  'blockedProviders', 'allowedModels', 'rateLimit', 'budgets',
  'providers', 'audit', 'pricingOverrides', 'spendPersistence',
  // GEPA optimization pipeline — file-loadable subsets. Runtime callbacks
  // (sink instances, etc.) are wired programmatically over these fields.
  'telemetryExport', 'shadowRouter', 'promptOptimization', 'autoOptimization',
  'costOptimization', 'pricingRefresh', 'rules', 'rulesRefresh',
])
```

- [ ] **Step 4: Fix `src/config-validator.ts` `KNOWN_TOP_LEVEL_KEYS`**

Replace the `KNOWN_TOP_LEVEL_KEYS` set with the complete set (this validator runs
on in-memory configs, so it includes the runtime callbacks too):

```ts
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'masterKey', 'defaultProvider', 'defaultModel',
  'rateLimit', 'budgets', 'allowedModels', 'blockedProviders',
  'maxInputLength', 'promptInjectionGuard', 'requestSigning',
  'keyExpiryMs', 'audit', 'providers', 'pricingOverrides',
  'spendPersistence', 'telemetryExport', 'shadowRouter',
  'promptOptimization', 'autoOptimization', 'costOptimization',
  'pricingRefresh', 'rules', 'rulesRefresh',
  'onBudgetWarning', 'onBudgetExceeded', 'onForecastAtRisk', 'onRequestComplete',
  'onPricingRefreshed', 'onRulesRefreshed',
])
```

- [ ] **Step 5: Run the tests to verify they pass + no regression**

Run (from repo root): `npx vitest run tests/config-loader.test.ts tests/config-validator.test.ts`
Expected: PASS (the new cases plus all existing config-loader cases).

Run the full core suite to be safe: `npx vitest run --exclude '**/cli.test.ts'`
Expected: all pass (the 11 cli.test.ts EACCES failures are a pre-existing sandbox issue, unrelated).

- [ ] **Step 6: Rebuild the `freerouter` dist so the linked package reflects the fix**

`config-manager-web` links `freerouter` via `file:../..`, which resolves to the
built `dist/`. Rebuild it:

Run (from repo root): `node node_modules/tsup/dist/cli-default.js`
Expected: `Build success` for ESM/CJS/DTS. (If the `.bin/tsup` shim is
executable in your environment, `npm run build` works too.)

- [ ] **Step 7: Commit (core)**

```bash
git add src/config-loader.ts src/config-validator.ts tests/config-loader.test.ts tests/config-validator.test.ts
git commit -m "fix(config): complete + reconcile known top-level key lists with RouterConfig"
```

---

## Task 1: Scaffold the monorepo

**Files:**
- Create: `config-manager-web/package.json`, `config-manager-web/.gitignore`, `config-manager-web/README.md`
- Create: `config-manager-web/server/package.json`, `config-manager-web/server/tsconfig.json`, `config-manager-web/server/vitest.config.ts`
- Create: `config-manager-web/web/package.json`, `config-manager-web/web/tsconfig.json`, `config-manager-web/web/vite.config.ts`, `config-manager-web/web/vitest.config.ts`, `config-manager-web/web/index.html`

- [ ] **Step 1: Create the workspace root `config-manager-web/package.json`**

```json
{
  "name": "config-manager-web",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "npm run test --workspace server && npm run test --workspace web",
    "typecheck": "npm run typecheck --workspace server && npm run typecheck --workspace web",
    "dev:server": "npm run dev --workspace server",
    "dev:web": "npm run dev --workspace web",
    "build": "npm run build --workspace server && npm run build --workspace web"
  }
}
```

- [ ] **Step 2: Create `config-manager-web/.gitignore`**

```
node_modules/
dist/
*.log
.env
coverage/
```

- [ ] **Step 3: Create `config-manager-web/README.md`**

```markdown
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
```

- [ ] **Step 4: Create `config-manager-web/server/package.json`**

```json
{
  "name": "@freerouter/config-manager-server",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "@fastify/cookie": "^9.3.1",
    "@fastify/secure-session": "^7.5.1",
    "openid-client": "^5.6.5",
    "freerouter": "file:../.."
  },
  "devDependencies": {
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 5: Create `config-manager-web/server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 6: Create `config-manager-web/server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 7: Create `config-manager-web/web/package.json`**

```json
{
  "name": "@freerouter/config-manager-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.3.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "jsdom": "^24.1.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 8: Create `config-manager-web/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 9: Create `config-manager-web/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7700',
      '/auth': 'http://127.0.0.1:7700',
    },
  },
})
```

- [ ] **Step 10: Create `config-manager-web/web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 11: Create `config-manager-web/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FreeRouter Config Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 12: Install and verify the workspace resolves**

Run (from `config-manager-web/`): `npm install`
Expected: installs without error; `node_modules/freerouter` is linked to the repo root.

Run: `ls node_modules/freerouter/dist/index.js`
Expected: the file exists (the `freerouter` package is built — if missing, run `npm run build` in the repo root first).

- [ ] **Step 13: Commit**

```bash
git add config-manager-web/package.json config-manager-web/.gitignore config-manager-web/README.md config-manager-web/server config-manager-web/web
git commit -m "chore(web-config): scaffold config-manager-web monorepo (server + web)"
```

---

## Task 2: Server types + env-var config loader

**Files:**
- Create: `config-manager-web/server/src/types.ts`
- Create: `config-manager-web/server/src/config.ts`
- Test: `config-manager-web/server/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadServerConfig } from '../src/config.js'

describe('loadServerConfig', () => {
  const base = {
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback',
    SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/etc/fr/environments.json',
    AUDIT_LOG_FILE: '/var/log/fr-admin-audit.jsonl',
  }

  it('parses a complete environment', () => {
    const cfg = loadServerConfig(base)
    expect(cfg.oidc.issuer).toBe('https://idp.example.com')
    expect(cfg.oidc.groupsClaim).toBe('groups')   // default
    expect(cfg.port).toBe(7700)                     // default
  })

  it('throws when a required var is missing', () => {
    const { OIDC_CLIENT_ID: _omit, ...rest } = base
    expect(() => loadServerConfig(rest)).toThrow(/OIDC_CLIENT_ID/)
  })

  it('throws when SESSION_SECRET is shorter than 32 chars', () => {
    expect(() => loadServerConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `config-manager-web/server/`): `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find `../src/config.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/types.ts`**

```ts
export type Role = 'admin' | 'viewer'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
  groupsClaim: string
}

export interface ServerConfig {
  port: number
  sessionSecret: string
  oidc: OidcConfig
  environmentsFile: string
  auditLogFile: string
}

export interface SessionUser {
  subject: string
  name: string
  groups: string[]
}

export interface EnvironmentPaths {
  config: string
  rules: string
  env: string
  pricing: string
  optimizedStore: string
  candidates: string
}

export interface Environment {
  id: string
  label: string
  paths: EnvironmentPaths
}

/** A document read from disk plus the version that must be echoed on write. */
export interface VersionedDoc<T> {
  data: T
  version: string
}
```

- [ ] **Step 4: Create `config-manager-web/server/src/config.ts`**

```ts
import type { ServerConfig } from './types.js'

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const v = env[key]
  if (v === undefined || v.trim() === '') {
    throw new Error(`[config] missing required environment variable: ${key}`)
  }
  return v
}

/** Build the server config from environment variables (defaults to process.env). */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const sessionSecret = required(env, 'SESSION_SECRET')
  if (sessionSecret.length < 32) {
    throw new Error('[config] SESSION_SECRET must be at least 32 characters')
  }
  return {
    port: env.PORT !== undefined ? Number(env.PORT) : 7700,
    sessionSecret,
    oidc: {
      issuer: required(env, 'OIDC_ISSUER'),
      clientId: required(env, 'OIDC_CLIENT_ID'),
      clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
      redirectUri: required(env, 'OIDC_REDIRECT_URI'),
      scopes: env.OIDC_SCOPES ?? 'openid profile email groups',
      groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups',
    },
    environmentsFile: required(env, 'ENVIRONMENTS_FILE'),
    auditLogFile: required(env, 'AUDIT_LOG_FILE'),
  }
}
```

- [ ] **Step 4b: Add a `typecheck` smoke (no emit) for the server**

The `package.json` already defines `typecheck`. No code change; this step is a reminder that later steps run it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/server/src/types.ts config-manager-web/server/src/config.ts config-manager-web/server/test/config.test.ts
git commit -m "feat(web-config): server config loader + shared types"
```

---

## Task 3: Environment registry

**Files:**
- Create: `config-manager-web/server/src/environments.ts`
- Test: `config-manager-web/server/test/environments.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/environments.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentRegistry } from '../src/environments.js'

describe('EnvironmentRegistry', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-env-'))
    file = join(dir, 'environments.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const sample = [{
    id: 'dev', label: 'Development',
    paths: { config: '/c.json', rules: '/r.json', env: '/.env', pricing: '/p.json', optimizedStore: '/o.json', candidates: '/cand.json' },
  }]

  it('loads environments and looks them up by id', () => {
    writeFileSync(file, JSON.stringify(sample), 'utf-8')
    const reg = EnvironmentRegistry.load(file)
    expect(reg.list().map(e => e.id)).toEqual(['dev'])
    expect(reg.get('dev')?.label).toBe('Development')
    expect(reg.get('nope')).toBeUndefined()
  })

  it('throws on a malformed environments file', () => {
    writeFileSync(file, '{ not json', 'utf-8')
    expect(() => EnvironmentRegistry.load(file)).toThrow(/environments/i)
  })

  it('throws when an entry is missing a required path', () => {
    writeFileSync(file, JSON.stringify([{ id: 'x', label: 'X', paths: { config: '/c.json' } }]), 'utf-8')
    expect(() => EnvironmentRegistry.load(file)).toThrow(/path/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/environments.test.ts`
Expected: FAIL — cannot find `../src/environments.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/environments.ts`**

```ts
import { readFileSync } from 'node:fs'
import type { Environment, EnvironmentPaths } from './types.js'

const REQUIRED_PATHS: (keyof EnvironmentPaths)[] = [
  'config', 'rules', 'env', 'pricing', 'optimizedStore', 'candidates',
]

export class EnvironmentRegistry {
  private readonly byId = new Map<string, Environment>()

  private constructor(envs: Environment[]) {
    for (const e of envs) this.byId.set(e.id, e)
  }

  static load(file: string): EnvironmentRegistry {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      throw new Error(`[environments] failed to read/parse ${file}: ${(err as Error).message}`)
    }
    if (!Array.isArray(raw)) {
      throw new Error('[environments] file must contain a JSON array of environments')
    }
    const envs: Environment[] = raw.map((e, i) => {
      const entry = e as Partial<Environment>
      if (typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.paths !== 'object' || entry.paths === null) {
        throw new Error(`[environments] entry ${i} missing id/label/paths`)
      }
      for (const p of REQUIRED_PATHS) {
        if (typeof (entry.paths as Record<string, unknown>)[p] !== 'string') {
          throw new Error(`[environments] entry "${entry.id}" missing path: ${p}`)
        }
      }
      return entry as Environment
    })
    return new EnvironmentRegistry(envs)
  }

  list(): Environment[] {
    return [...this.byId.values()]
  }

  get(id: string): Environment | undefined {
    return this.byId.get(id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/environments.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/environments.ts config-manager-web/server/test/environments.test.ts
git commit -m "feat(web-config): environment registry"
```

---

## Task 4: Config store (atomic write + optimistic lock)

**Files:**
- Create: `config-manager-web/server/src/store/config-store.ts`
- Test: `config-manager-web/server/test/config-store.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/config-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileStore, StaleVersionError } from '../src/store/config-store.js'

describe('JsonFileStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-store-')); path = join(dir, 'config.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns empty object + stable version when file is absent', () => {
    const store = new JsonFileStore(path)
    const a = store.read()
    expect(a.data).toEqual({})
    const b = store.read()
    expect(b.version).toBe(a.version)   // deterministic for the same (absent) content
  })

  it('writes data and round-trips it with a new version', () => {
    const store = new JsonFileStore(path)
    const { version } = store.read()
    const next = store.write({ defaultModel: 'gpt-4o' }, version)
    expect(next.data).toEqual({ defaultModel: 'gpt-4o' })
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ defaultModel: 'gpt-4o' })
    expect(store.read().version).toBe(next.version)
  })

  it('rejects a write whose version no longer matches disk (optimistic lock)', () => {
    const store = new JsonFileStore(path)
    const stale = store.read().version
    store.write({ a: 1 }, stale)            // advances the version
    expect(() => store.write({ a: 2 }, stale)).toThrow(StaleVersionError)
  })

  it('writes atomically (no .tmp left behind)', () => {
    const store = new JsonFileStore(path)
    store.write({ a: 1 }, store.read().version)
    expect(existsSync(path + '.tmp')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-store.test.ts`
Expected: FAIL — cannot find `../src/store/config-store.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/store/config-store.ts`**

```ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VersionedDoc } from '../types.js'

export class StaleVersionError extends Error {
  constructor() {
    super('version mismatch: the document changed on disk')
    this.name = 'StaleVersionError'
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * A JSON document on disk with content-hash optimistic locking. An absent file
 * reads as `{}` with the hash of the empty-object canonical form, so a first
 * write is a normal version transition rather than a special case.
 */
export class JsonFileStore<T extends object = Record<string, unknown>> {
  constructor(private readonly path: string) {}

  private bytes(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf-8') : '{}'
  }

  read(): VersionedDoc<T> {
    const raw = this.bytes()
    return { data: JSON.parse(raw) as T, version: sha256(raw) }
  }

  /** Write `data` iff `expectedVersion` still matches disk; returns the new doc. */
  write(data: T, expectedVersion: string): VersionedDoc<T> {
    const current = sha256(this.bytes())
    if (current !== expectedVersion) throw new StaleVersionError()
    const serialized = JSON.stringify(data, null, 2)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, serialized, 'utf-8')
    renameSync(tmp, this.path)
    return { data, version: sha256(serialized) }
  }
}
```

Note: `read()` hashes the raw file bytes, while `write()` returns the hash of the canonical `JSON.stringify(data, null, 2)`. After a write the file contains exactly that serialized form, so the next `read()` recomputes the identical hash — the test `store.read().version === next.version` holds.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/store/config-store.ts config-manager-web/server/test/config-store.test.ts
git commit -m "feat(web-config): json file store with optimistic locking"
```

---

## Task 5: Audit log

**Files:**
- Create: `config-manager-web/server/src/store/audit-log.ts`
- Test: `config-manager-web/server/test/audit-log.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/audit-log.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../src/store/audit-log.js'

describe('AuditLog', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-audit-')); path = join(dir, 'audit.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends records and reads them back newest-first', () => {
    const log = new AuditLog(path)
    log.record({ subject: 'alice', environment: 'dev', action: 'config:save', target: 'config', beforeHash: 'a', afterHash: 'b' })
    log.record({ subject: 'bob', environment: 'prod', action: 'config:save', target: 'config', beforeHash: 'c', afterHash: 'd' })
    const recent = log.recent(10)
    expect(recent).toHaveLength(2)
    expect(recent[0]!.subject).toBe('bob')   // newest first
    expect(typeof recent[0]!.timestamp).toBe('number')
  })

  it('returns empty when the log file does not exist yet', () => {
    expect(new AuditLog(join(dir, 'missing.jsonl')).recent(10)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/audit-log.test.ts`
Expected: FAIL — cannot find `../src/store/audit-log.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/store/audit-log.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AuditRecordInput {
  subject: string
  environment: string
  action: string
  target: string
  beforeHash?: string
  afterHash?: string
}

export interface AuditRecord extends AuditRecordInput {
  timestamp: number
}

/** Append-only JSONL audit log of mutating admin actions. */
export class AuditLog {
  constructor(private readonly path: string) {}

  record(input: AuditRecordInput): void {
    const rec: AuditRecord = { timestamp: Date.now(), ...input }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf-8')
  }

  /** Most recent `limit` records, newest first. */
  recent(limit: number): AuditRecord[] {
    if (!existsSync(this.path)) return []
    const lines = readFileSync(this.path, 'utf-8').split('\n').filter(l => l.trim() !== '')
    const out: AuditRecord[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i]!) as AuditRecord) } catch { /* skip corrupt line */ }
    }
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/audit-log.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/store/audit-log.ts config-manager-web/server/test/audit-log.test.ts
git commit -m "feat(web-config): append-only audit log"
```

---

## Task 6: Validation (reuse freerouter)

**Files:**
- Create: `config-manager-web/server/src/validation.ts`
- Test: `config-manager-web/server/test/validation.test.ts`

**Depends on Task 0:** the core key-lists must already be reconciled and the
`freerouter` dist rebuilt, or this task's tests will see false-positive unknown
keys for `costOptimization`/`rules`/etc.

- [ ] **Step 1: Confirm the reused exports exist**

Run (from repo root `/Users/rajat.a.ahuja/Dev/FreeRouter`): `grep -nE "validateConfig|validateConfigKeys" src/index.ts`
Expected: both `validateConfig` and `validateConfigKeys` are exported. (They are — `validateConfig` from `./config-validator.js`, `validateConfigKeys` from `./config-loader.js`.) `validateConfig` returns `{ valid: boolean; errors: string[]; warnings: string[] }`; unknown keys are reported in `warnings` (not `errors`), so structural validity is independent of key typos.

- [ ] **Step 2: Write the failing test**

`config-manager-web/server/test/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateConfigPayload } from '../src/validation.js'

describe('validateConfigPayload', () => {
  it('accepts a minimal valid config', () => {
    const result = validateConfigPayload({ defaultProvider: 'google', defaultModel: 'gemini-2.5-flash' })
    expect(result.ok).toBe(true)
  })

  it('flags unknown top-level keys', () => {
    const result = validateConfigPayload({ notAKey: true })
    expect(result.ok).toBe(false)
    expect(result.messages.join(' ')).toMatch(/notAKey/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/validation.test.ts`
Expected: FAIL — cannot find `../src/validation.js`.

- [ ] **Step 4: Create `config-manager-web/server/src/validation.ts`**

```ts
import { validateConfig, validateConfigKeys } from 'freerouter'

export interface ValidationOutcome {
  ok: boolean
  messages: string[]
}

/**
 * Validate a candidate FreeRouter config object using the library's own
 * validators: unknown top-level keys (typo detection) plus structural checks.
 * Returns a flat list of human-readable messages for the API's 422 response.
 */
export function validateConfigPayload(config: unknown): ValidationOutcome {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, messages: ['config must be a JSON object'] }
  }
  const messages: string[] = []

  const unknown = validateConfigKeys(config as Record<string, unknown>)
  for (const k of unknown) messages.push(`unknown top-level config key: "${k}"`)

  const structural = validateConfig(config)
  if (!structural.valid) {
    for (const e of structural.errors) messages.push(e)
  }

  return { ok: messages.length === 0, messages }
}
```

Note: `validateConfig` returns `ConfigValidationResult` = `{ valid: boolean; errors: string[]; warnings: string[] }` (confirmed). Unknown top-level keys are surfaced via `validateConfigKeys` (the loader's complete list after Task 0); `validateConfig`'s own unknown-key entries are `warnings` and are intentionally not consumed here, so there is no duplication. The structural `errors` (budgets, rateLimit, arrays, masterKey, etc.) are the rejection surface.

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/validation.test.ts`
Expected: PASS (2 tests). The "unknown key" case passes because `validateConfigKeys` reports `notAKey`; the "valid config" case passes because a config of documented keys yields no unknown keys and no structural errors.

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/server/src/validation.ts config-manager-web/server/test/validation.test.ts
git commit -m "feat(web-config): config validation via freerouter validators"
```

---

## Task 7: RBAC

**Files:**
- Create: `config-manager-web/server/src/auth/rbac.ts`
- Test: `config-manager-web/server/test/rbac.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/rbac.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RoleResolver } from '../src/auth/rbac.js'

const mapping = {
  // group -> default role
  defaults: { 'fr-admins': 'admin', 'fr-viewers': 'viewer' },
  // per-environment overrides: env -> group -> role
  perEnvironment: {
    prod: { 'fr-admins': 'viewer', 'fr-prod-admins': 'admin' },
  },
} as const

describe('RoleResolver', () => {
  const resolver = new RoleResolver(mapping)

  it('resolves the highest default role from a user\'s groups', () => {
    expect(resolver.roleFor(['fr-viewers'], 'dev')).toBe('viewer')
    expect(resolver.roleFor(['fr-admins'], 'dev')).toBe('admin')
  })

  it('applies per-environment overrides', () => {
    // fr-admins is downgraded to viewer on prod
    expect(resolver.roleFor(['fr-admins'], 'prod')).toBe('viewer')
    // fr-prod-admins is admin only on prod
    expect(resolver.roleFor(['fr-prod-admins'], 'prod')).toBe('admin')
    expect(resolver.roleFor(['fr-prod-admins'], 'dev')).toBeUndefined()
  })

  it('returns undefined when no group maps to a role', () => {
    expect(resolver.roleFor(['random'], 'dev')).toBeUndefined()
  })

  it('admin wins when multiple groups grant different roles', () => {
    expect(resolver.roleFor(['fr-viewers', 'fr-admins'], 'dev')).toBe('admin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rbac.test.ts`
Expected: FAIL — cannot find `../src/auth/rbac.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/auth/rbac.ts`**

```ts
import type { Role } from '../types.js'

export interface RoleMapping {
  /** group -> role applied in every environment unless overridden. */
  defaults: Record<string, Role>
  /** environment id -> (group -> role) override; replaces the default for that env. */
  perEnvironment?: Record<string, Record<string, Role>>
}

const RANK: Record<Role, number> = { viewer: 1, admin: 2 }

/** Resolves a user's effective role in an environment from their IdP groups. */
export class RoleResolver {
  constructor(private readonly mapping: RoleMapping) {}

  roleFor(groups: string[], environmentId: string): Role | undefined {
    const override = this.mapping.perEnvironment?.[environmentId]
    let best: Role | undefined
    for (const g of groups) {
      const role = override?.[g] ?? (override !== undefined && g in override ? undefined : this.mapping.defaults[g])
      if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role
    }
    return best
  }
}
```

Note on the override rule: when an environment has an override map, a group present in that override uses the override role; a group absent from the override falls back to its `defaults` role. The expression above implements exactly that — `override?.[g]` takes the override if the group is listed; otherwise it uses the default. (The middle `g in override` guard is redundant given `??` and is simplified in the next step.)

- [ ] **Step 3b: Simplify the resolution expression**

Replace the loop body in `roleFor` with the clearer equivalent:

```ts
    for (const g of groups) {
      const role = override?.[g] ?? this.mapping.defaults[g]
      if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role
    }
```

This satisfies all four test cases: on `prod`, `fr-admins` → override `viewer`; `fr-prod-admins` → override `admin`; on `dev` (no override map) `fr-prod-admins` → `defaults['fr-prod-admins']` which is undefined.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rbac.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/auth/rbac.ts config-manager-web/server/test/rbac.test.ts
git commit -m "feat(web-config): RBAC role resolver with per-environment overrides"
```

---

## Task 8: OIDC provider abstraction

**Files:**
- Create: `config-manager-web/server/src/auth/oidc.ts`
- Test: `config-manager-web/server/test/oidc.test.ts`

The real OIDC client is wrapped behind an interface so routes and tests depend on the interface, not `openid-client`. Tests use a fake; the real implementation is exercised manually against an IdP.

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/oidc.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { OidcProvider, AuthRequest, Claims } from '../src/auth/oidc.js'

// A fake provider proving the interface is usable & stable.
class FakeOidc implements OidcProvider {
  authUrl(req: AuthRequest): string {
    return `https://idp/auth?state=${req.state}&nonce=${req.nonce}&redirect_uri=${encodeURIComponent(req.redirectUri)}`
  }
  async exchange(): Promise<Claims> {
    return { sub: 'user-1', name: 'Ada', groups: ['fr-admins'] }
  }
}

describe('OidcProvider contract', () => {
  it('produces an auth URL carrying state, nonce, redirect', () => {
    const p: OidcProvider = new FakeOidc()
    const url = p.authUrl({ state: 's1', nonce: 'n1', redirectUri: 'https://app/cb' })
    expect(url).toContain('state=s1')
    expect(url).toContain('nonce=n1')
    expect(url).toContain(encodeURIComponent('https://app/cb'))
  })

  it('exchange returns normalized claims', async () => {
    const p: OidcProvider = new FakeOidc()
    const claims = await p.exchange({ callbackUrl: 'https://app/cb?code=x&state=s1', state: 's1', nonce: 'n1' })
    expect(claims.sub).toBe('user-1')
    expect(claims.groups).toContain('fr-admins')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/oidc.test.ts`
Expected: FAIL — cannot find `../src/auth/oidc.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/auth/oidc.ts`**

```ts
import { Issuer, generators, type Client } from 'openid-client'
import type { OidcConfig } from '../types.js'

export interface AuthRequest {
  state: string
  nonce: string
  redirectUri: string
}

export interface ExchangeRequest {
  callbackUrl: string
  state: string
  nonce: string
}

export interface Claims {
  sub: string
  name: string
  groups: string[]
}

export interface OidcProvider {
  authUrl(req: AuthRequest): string
  exchange(req: ExchangeRequest): Promise<Claims>
}

export const newState = (): string => generators.state()
export const newNonce = (): string => generators.nonce()

/** Real OIDC provider backed by openid-client. Build once at startup via `create`. */
export class OpenIdConnectProvider implements OidcProvider {
  private constructor(private readonly client: Client, private readonly cfg: OidcConfig) {}

  static async create(cfg: OidcConfig): Promise<OpenIdConnectProvider> {
    const issuer = await Issuer.discover(cfg.issuer)
    const client = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [cfg.redirectUri],
      response_types: ['code'],
    })
    return new OpenIdConnectProvider(client, cfg)
  }

  authUrl(req: AuthRequest): string {
    return this.client.authorizationUrl({
      scope: this.cfg.scopes,
      state: req.state,
      nonce: req.nonce,
      redirect_uri: req.redirectUri,
    })
  }

  async exchange(req: ExchangeRequest): Promise<Claims> {
    const params = this.client.callbackParams(req.callbackUrl)
    const tokenSet = await this.client.callback(this.cfg.redirectUri, params, {
      state: req.state,
      nonce: req.nonce,
    })
    const claims = tokenSet.claims()
    const groupsRaw = (claims as Record<string, unknown>)[this.cfg.groupsClaim]
    const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : []
    return {
      sub: claims.sub,
      name: (claims.name as string | undefined) ?? (claims.preferred_username as string | undefined) ?? claims.sub,
      groups,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/oidc.test.ts`
Expected: PASS (2 tests). (The real `OpenIdConnectProvider` is not exercised by unit tests; the fake validates the contract.)

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/auth/oidc.ts config-manager-web/server/test/oidc.test.ts
git commit -m "feat(web-config): OIDC provider interface + openid-client impl"
```

---

## Task 9: App assembly + auth routes + config routes

**Files:**
- Create: `config-manager-web/server/src/app.ts`
- Create: `config-manager-web/server/src/routes/auth-routes.ts`
- Create: `config-manager-web/server/src/routes/config-routes.ts`
- Create: `config-manager-web/server/src/server.ts`
- Create: `config-manager-web/server/test/helpers.ts`
- Test: `config-manager-web/server/test/auth-routes.test.ts`
- Test: `config-manager-web/server/test/config-routes.test.ts`

This task wires the units into a Fastify app via a `buildApp(deps)` factory so tests can inject a fake `OidcProvider`, a temp `EnvironmentRegistry`, and temp stores. The session is a `@fastify/secure-session` cookie holding the `SessionUser`.

- [ ] **Step 1: Write the test helper**

`config-manager-web/server/test/helpers.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type AppDeps } from '../src/app.js'
import { EnvironmentRegistry } from '../src/environments.js'
import { RoleResolver } from '../src/auth/rbac.js'
import { AuditLog } from '../src/store/audit-log.js'
import type { OidcProvider, Claims } from '../src/auth/oidc.js'

export function makeTempEnv(): { dir: string; environmentsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fr-app-'))
  const paths = {
    config: join(dir, 'config.json'), rules: join(dir, 'rules.json'), env: join(dir, '.env'),
    pricing: join(dir, 'pricing.json'), optimizedStore: join(dir, 'opt.json'), candidates: join(dir, 'cand.json'),
  }
  const environmentsFile = join(dir, 'environments.json')
  writeFileSync(environmentsFile, JSON.stringify([
    { id: 'dev', label: 'Development', paths },
    { id: 'prod', label: 'Production', paths: { ...paths, config: join(dir, 'prod-config.json') } },
  ]), 'utf-8')
  return { dir, environmentsFile }
}

export class FakeOidc implements OidcProvider {
  constructor(private readonly claims: Claims) {}
  authUrl(): string { return 'https://idp/auth?state=test' }
  async exchange(): Promise<Claims> { return this.claims }
}

export function buildTestApp(opts: { claims?: Claims } = {}): ReturnType<typeof buildApp> {
  const { dir, environmentsFile } = makeTempEnv()
  const deps: AppDeps = {
    sessionSecret: 'k'.repeat(32),
    oidc: new FakeOidc(opts.claims ?? { sub: 'admin-1', name: 'Admin', groups: ['fr-admins'] }),
    environments: EnvironmentRegistry.load(environmentsFile),
    roles: new RoleResolver({ defaults: { 'fr-admins': 'admin', 'fr-viewers': 'viewer' } }),
    audit: new AuditLog(join(dir, 'audit.jsonl')),
    redirectUri: 'http://localhost/auth/callback',
    afterLoginRedirect: '/',
  }
  return buildApp(deps)
}
```

- [ ] **Step 2: Write the failing auth-routes test**

`config-manager-web/server/test/auth-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp } from './helpers.js'

describe('auth routes', () => {
  it('/auth/me is 401 before login', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('/auth/login redirects to the IdP and sets a state cookie', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('https://idp/auth')
    await app.close()
  })

  it('full login flow: callback establishes a session, /auth/me returns the user', async () => {
    const app = await buildTestApp({ claims: { sub: 'u1', name: 'Ada', groups: ['fr-admins'] } })
    const login = await app.inject({ method: 'GET', url: '/auth/login' })
    const cookies = login.cookies.map(c => `${c.name}=${c.value}`).join('; ')
    // Our FakeOidc ignores params; provide state matching the cookie via the login redirect.
    const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookies } })
    expect(cb.statusCode).toBe(302)
    const sessionCookies = cb.cookies.map(c => `${c.name}=${c.value}`).join('; ')
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: sessionCookies } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ subject: 'u1', name: 'Ada' })
    await app.close()
  })
})
```

- [ ] **Step 3: Write the failing config-routes test**

`config-manager-web/server/test/config-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
  const c1 = loginRes.cookies.map(c => `${c.name}=${c.value}`).join('; ')
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: c1 } })
  return cb.cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

describe('config routes', () => {
  it('lists environments for an authenticated user', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/api/env', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((e: { id: string }) => e.id)).toContain('dev')
    await app.close()
  })

  it('reads an empty config with a version, then writes it back', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/config', headers: { cookie },
      payload: { data: { defaultModel: 'gemini-2.5-flash' }, version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data).toMatchObject({ defaultModel: 'gemini-2.5-flash' })
  })

  it('rejects a stale write with 409', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { a: 1 }, version } })
    const stale = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { a: 2 }, version } })
    expect(stale.statusCode).toBe(409)
    await app.close()
  })

  it('rejects an invalid config with 422', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { bogusKey: 1 }, version } })
    expect(res.statusCode).toBe(422)
    expect(JSON.stringify(res.json())).toMatch(/bogusKey/)
    await app.close()
  })

  it('forbids a viewer from writing (403)', async () => {
    const app = await buildTestApp({ claims: { sub: 'v1', name: 'Viewer', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'x' }, version } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('401 for unauthenticated config read', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/config' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
```

- [ ] **Step 4: Run both tests to verify they fail**

Run: `npx vitest run test/auth-routes.test.ts test/config-routes.test.ts`
Expected: FAIL — cannot find `../src/app.js`.

- [ ] **Step 5: Create `config-manager-web/server/src/app.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import secureSession from '@fastify/secure-session'
import { createHash } from 'node:crypto'
import type { OidcProvider } from './auth/oidc.js'
import type { EnvironmentRegistry } from './environments.js'
import type { RoleResolver } from './auth/rbac.js'
import type { AuditLog } from './store/audit-log.js'
import { registerAuthRoutes } from './routes/auth-routes.js'
import { registerConfigRoutes } from './routes/config-routes.js'

export interface AppDeps {
  sessionSecret: string
  oidc: OidcProvider
  environments: EnvironmentRegistry
  roles: RoleResolver
  audit: AuditLog
  redirectUri: string
  afterLoginRedirect: string
}

// Derive a 32-byte secure-session key deterministically from the secret.
const sessionKey = (secret: string): Buffer => createHash('sha256').update(secret).digest()

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(secureSession, {
    key: sessionKey(deps.sessionSecret),
    cookieName: 'fr_admin_session',
    cookie: { path: '/', httpOnly: true, sameSite: 'lax' },
  })

  app.decorate('deps', deps)
  await app.register(registerAuthRoutes)
  await app.register(registerConfigRoutes)
  return app
}

declare module 'fastify' {
  interface FastifyInstance { deps: AppDeps }
}
```

- [ ] **Step 6: Create `config-manager-web/server/src/routes/auth-routes.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { newState, newNonce } from '../auth/oidc.js'
import type { SessionUser } from '../types.js'

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { oidc, redirectUri, afterLoginRedirect } = app.deps

  app.get('/auth/login', async (req, reply) => {
    const state = newState()
    const nonce = newNonce()
    req.session.set('oauth_state', state)
    req.session.set('oauth_nonce', nonce)
    return reply.redirect(oidc.authUrl({ state, nonce, redirectUri }))
  })

  app.get('/auth/callback', async (req, reply) => {
    const state = req.session.get('oauth_state') as string | undefined
    const nonce = req.session.get('oauth_nonce') as string | undefined
    if (state === undefined || nonce === undefined) {
      return reply.code(400).send({ error: 'missing auth state' })
    }
    const url = new URL(req.url, redirectUri)
    const claims = await oidc.exchange({ callbackUrl: url.toString(), state, nonce })
    const user: SessionUser = { subject: claims.sub, name: claims.name, groups: claims.groups }
    req.session.set('user', user)
    req.session.set('oauth_state', undefined)
    req.session.set('oauth_nonce', undefined)
    return reply.redirect(afterLoginRedirect)
  })

  app.get('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.redirect('/')
  })

  app.get('/auth/me', async (req, reply) => {
    const user = req.session.get('user') as SessionUser | undefined
    if (user === undefined) return reply.code(401).send({ error: 'unauthenticated' })
    return reply.send(user)
  })
}
```

- [ ] **Step 7: Create `config-manager-web/server/src/routes/config-routes.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore, StaleVersionError } from '../store/config-store.js'
import { validateConfigPayload } from '../validation.js'
import type { SessionUser, Role } from '../types.js'

function currentUser(req: FastifyRequest): SessionUser | undefined {
  return req.session.get('user') as SessionUser | undefined
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit } = app.deps

  // Require an authenticated session for everything under /api.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }
  })

  app.get('/api/env', async (req, reply) => {
    const user = currentUser(req)!
    const visible = environments.list()
      .filter(e => roles.roleFor(user.groups, e.id) !== undefined)
      .map(e => ({ id: e.id, label: e.label, role: roles.roleFor(user.groups, e.id) as Role }))
    return reply.send(visible)
  })

  app.get('/api/env/:id/config', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) === undefined) return reply.code(403).send({ error: 'forbidden' })
    const store = new JsonFileStore(env.paths.config)
    return reply.send(store.read())
  })

  app.put('/api/env/:id/config', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) !== 'admin') return reply.code(403).send({ error: 'forbidden' })

    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })

    const validation = validateConfigPayload(body.data)
    if (!validation.ok) return reply.code(422).send({ error: 'invalid config', messages: validation.messages })

    const store = new JsonFileStore(env.paths.config)
    const before = store.read()
    try {
      const next = store.write(body.data as object, body.version)
      audit.record({
        subject: user.subject, environment: id, action: 'config:save', target: 'config',
        beforeHash: before.version, afterHash: next.version,
      })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })
}
```

- [ ] **Step 8: Create `config-manager-web/server/src/server.ts`**

```ts
import { loadServerConfig } from './config.js'
import { EnvironmentRegistry } from './environments.js'
import { RoleResolver, type RoleMapping } from './auth/rbac.js'
import { AuditLog } from './store/audit-log.js'
import { OpenIdConnectProvider } from './auth/oidc.js'
import { buildApp } from './app.js'
import { readFileSync } from 'node:fs'

async function main(): Promise<void> {
  const cfg = loadServerConfig()
  const environments = EnvironmentRegistry.load(cfg.environmentsFile)
  const roleMapping = JSON.parse(readFileSync(process.env.ROLE_MAPPING_FILE ?? './role-mapping.json', 'utf-8')) as RoleMapping
  const roles = new RoleResolver(roleMapping)
  const audit = new AuditLog(cfg.auditLogFile)
  const oidc = await OpenIdConnectProvider.create(cfg.oidc)

  const app = await buildApp({
    sessionSecret: cfg.sessionSecret,
    oidc, environments, roles, audit,
    redirectUri: cfg.oidc.redirectUri,
    afterLoginRedirect: '/',
  })
  await app.listen({ host: '0.0.0.0', port: cfg.port })
  // eslint-disable-next-line no-console
  console.log(`[config-manager-web] listening on :${cfg.port}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 9: Run the route tests to verify they pass**

Run: `npx vitest run test/auth-routes.test.ts test/config-routes.test.ts`
Expected: PASS — auth (3) + config (6) tests green.

If `@fastify/secure-session` types complain about `req.session.get/set` for arbitrary keys, add a session typing in `app.ts`:
```ts
declare module '@fastify/secure-session' {
  interface SessionData {
    user?: import('./types.js').SessionUser
    oauth_state?: string
    oauth_nonce?: string
  }
}
```

- [ ] **Step 10: Run the full server suite + typecheck**

Run: `npx vitest run`
Run: `npm run typecheck`
Expected: all server tests pass; no type errors.

- [ ] **Step 11: Commit**

```bash
git add config-manager-web/server/src/app.ts config-manager-web/server/src/routes config-manager-web/server/src/server.ts config-manager-web/server/test/helpers.ts config-manager-web/server/test/auth-routes.test.ts config-manager-web/server/test/config-routes.test.ts
git commit -m "feat(web-config): app assembly, auth routes, config routes (RBAC + optimistic lock + audit)"
```

---

## Task 10: Frontend scaffold — theme, API client, auth gate, app shell

**Files:**
- Create: `config-manager-web/web/src/main.tsx`, `theme.css`, `types.ts`, `api.ts`
- Create: `config-manager-web/web/src/auth/AuthGate.tsx`
- Create: `config-manager-web/web/src/app/AppShell.tsx`, `EnvSwitcher.tsx`
- Create: `config-manager-web/web/src/components/{Button,Field,TextInput,Toggle,Toast,ConflictBanner}.tsx`
- Create: `config-manager-web/web/test/setup.ts`, `config-manager-web/web/test/api.test.ts`

- [ ] **Step 1: Write the failing API-client test**

`config-manager-web/web/test/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, ApiError } from '../src/api.js'

describe('api client', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('GET returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })))
    expect(await api.get('/api/env')).toEqual({ ok: 1 })
  })

  it('throws ApiError with status on 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'version conflict' }), { status: 409 })))
    await expect(api.put('/api/env/dev/config', {})).rejects.toMatchObject({ status: 409 })
  })

  it('throws ApiError carrying validation messages on 422', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: ['bad: x'] }), { status: 422 })))
    await expect(api.put('/api/env/dev/config', {})).rejects.toMatchObject({ status: 422, messages: ['bad: x'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `config-manager-web/web/`): `npx vitest run test/api.test.ts`
Expected: FAIL — cannot find `../src/api.js`.

- [ ] **Step 3: Create `config-manager-web/web/test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 4: Create `config-manager-web/web/src/api.ts`**

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string, public messages?: string[]) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (res.status === 401) throw new ApiError(401, 'unauthenticated')
  if (!res.ok) {
    let payload: { error?: string; messages?: string[] } = {}
    try { payload = await res.json() } catch { /* ignore */ }
    throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`, payload.messages)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T = unknown>(url: string) => request<T>('GET', url),
  put: <T = unknown>(url: string, body: unknown) => request<T>('PUT', url, body),
  post: <T = unknown>(url: string, body: unknown) => request<T>('POST', url, body),
  del: <T = unknown>(url: string) => request<T>('DELETE', url),
}
```

- [ ] **Step 5: Run the API test to verify it passes**

Run: `npx vitest run test/api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Create `config-manager-web/web/src/theme.css` (Accenture light)**

```css
:root {
  --acc-purple: #A100FF;
  --acc-purple-hover: #8A00D9;
  --surface: #FFFFFF;
  --surface-2: #F2F2F2;
  --border: #D6D6D6;
  --text: #1A1A1A;
  --text-muted: #5A5A5A;
  --danger: #C4001D;
  --ok: #1B7F3B;
  --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font); color: var(--text); background: var(--surface-2); }
a { color: var(--acc-purple); }
.btn {
  background: var(--acc-purple); color: #fff; border: none; border-radius: var(--radius);
  padding: 8px 14px; font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--acc-purple-hover); }
.btn:disabled { background: var(--border); cursor: not-allowed; }
.btn--ghost { background: transparent; color: var(--acc-purple); border: 1px solid var(--acc-purple); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
input, select {
  width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text);
}
input:focus, select:focus { outline: 2px solid var(--acc-purple); outline-offset: 1px; }
.field { margin-bottom: 14px; }
.field > label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.header { display: flex; align-items: center; gap: 16px; background: var(--surface); border-bottom: 2px solid var(--acc-purple); padding: 10px 16px; }
.header__brand { font-weight: 700; color: var(--acc-purple); }
.header__spacer { flex: 1; }
.layout { display: grid; grid-template-columns: 220px 1fr; gap: 16px; padding: 16px; }
.nav a { display: block; padding: 8px 10px; border-radius: var(--radius); color: var(--text); text-decoration: none; }
.nav a.active { background: var(--surface); border-left: 3px solid var(--acc-purple); font-weight: 600; }
.banner { padding: 10px 14px; border-radius: var(--radius); margin-bottom: 12px; }
.banner--conflict { background: #FDECEC; color: var(--danger); border: 1px solid var(--danger); }
.toast { position: fixed; bottom: 16px; right: 16px; background: var(--text); color: #fff; padding: 10px 14px; border-radius: var(--radius); }
```

- [ ] **Step 7: Create `config-manager-web/web/src/types.ts`**

```ts
export type Role = 'admin' | 'viewer'
export interface MeResponse { subject: string; name: string; groups: string[] }
export interface EnvSummary { id: string; label: string; role: Role }
export interface VersionedDoc<T = Record<string, unknown>> { data: T; version: string }
```

- [ ] **Step 8: Create the component kit**

`config-manager-web/web/src/components/Button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from 'react'
export function Button({ variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  return <button className={variant === 'ghost' ? 'btn btn--ghost' : 'btn'} {...props} />
}
```

`config-manager-web/web/src/components/Field.tsx`:
```tsx
import type { ReactNode } from 'react'
export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  )
}
```

`config-manager-web/web/src/components/TextInput.tsx`:
```tsx
import type { InputHTMLAttributes } from 'react'
export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} />
}
```

`config-manager-web/web/src/components/Toggle.tsx`:
```tsx
export function Toggle({ checked, onChange, id, label }: { checked: boolean; onChange: (v: boolean) => void; id?: string; label: string }) {
  return (
    <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
      <input id={id} type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
```

`config-manager-web/web/src/components/Toast.tsx`:
```tsx
export function Toast({ message }: { message: string | null }) {
  if (message === null) return null
  return <div className="toast" role="status">{message}</div>
}
```

`config-manager-web/web/src/components/ConflictBanner.tsx`:
```tsx
import { Button } from './Button.js'
export function ConflictBanner({ onReload }: { onReload: () => void }) {
  return (
    <div className="banner banner--conflict" role="alert">
      This configuration changed on the server since you loaded it.{' '}
      <Button variant="ghost" onClick={onReload}>Reload latest</Button>
    </div>
  )
}
```

- [ ] **Step 9: Create `AuthGate`, `EnvSwitcher`, `AppShell`, `main.tsx`**

`config-manager-web/web/src/auth/AuthGate.tsx`:
```tsx
import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api.js'
import type { MeResponse } from '../types.js'

export function AuthGate({ children }: { children: (me: MeResponse) => ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api.get<MeResponse>('/auth/me')
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) window.location.href = '/auth/login' })
      .finally(() => setLoading(false))
  }, [])
  if (loading) return <div className="card" style={{ margin: 16 }}>Loading…</div>
  if (me === null) return <div className="card" style={{ margin: 16 }}>Redirecting to sign in…</div>
  return <>{children(me)}</>
}
```

`config-manager-web/web/src/app/EnvSwitcher.tsx`:
```tsx
import type { EnvSummary } from '../types.js'
export function EnvSwitcher({ envs, value, onChange }: { envs: EnvSummary[]; value: string; onChange: (id: string) => void }) {
  return (
    <select aria-label="Environment" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
      {envs.map(e => <option key={e.id} value={e.id}>{e.label} ({e.role})</option>)}
    </select>
  )
}
```

`config-manager-web/web/src/app/AppShell.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { EnvSummary, MeResponse } from '../types.js'
import { EnvSwitcher } from './EnvSwitcher.js'
import { GeneralSection } from '../sections/GeneralSection.js'
import { ProvidersSection } from '../sections/ProvidersSection.js'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
] as const
type SectionId = typeof SECTIONS[number]['id']

export function AppShell({ me }: { me: MeResponse }) {
  const [envs, setEnvs] = useState<EnvSummary[]>([])
  const [envId, setEnvId] = useState<string>('')
  const [section, setSection] = useState<SectionId>('general')

  useEffect(() => {
    api.get<EnvSummary[]>('/api/env').then((list) => {
      setEnvs(list)
      if (list[0] !== undefined) setEnvId(list[0].id)
    })
  }, [])

  const env = envs.find(e => e.id === envId)
  const canWrite = env?.role === 'admin'

  return (
    <div>
      <header className="header">
        <span className="header__brand">FreeRouter Admin</span>
        {envs.length > 0 && <EnvSwitcher envs={envs} value={envId} onChange={setEnvId} />}
        <span className="header__spacer" />
        <span>{me.name}</span>
        <a href="/auth/logout">Sign out</a>
      </header>
      <div className="layout">
        <nav className="nav">
          {SECTIONS.map(s => (
            <a key={s.id} className={s.id === section ? 'active' : ''} href="#"
               onClick={(e) => { e.preventDefault(); setSection(s.id) }}>{s.label}</a>
          ))}
        </nav>
        <main>
          {envId === '' ? <div className="card">No environments available to you.</div>
            : section === 'general' ? <GeneralSection envId={envId} canWrite={canWrite} />
            : <ProvidersSection envId={envId} canWrite={canWrite} />}
        </main>
      </div>
    </div>
  )
}
```

`config-manager-web/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import { AuthGate } from './auth/AuthGate.js'
import { AppShell } from './app/AppShell.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{(me) => <AppShell me={me} />}</AuthGate>
  </StrictMode>,
)
```

- [ ] **Step 10: Add the shared `useConfig` hook**

`config-manager-web/web/src/app/useConfig.ts`:
```ts
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api.js'
import type { VersionedDoc } from '../types.js'

export interface UseConfig<T extends object> {
  data: T | null
  version: string
  loading: boolean
  conflict: boolean
  errors: string[]
  toast: string | null
  reload: () => void
  save: (data: T) => Promise<void>
}

export function useConfig<T extends object = Record<string, unknown>>(envId: string): UseConfig<T> {
  const [data, setData] = useState<T | null>(null)
  const [version, setVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [conflict, setConflict] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true); setConflict(false); setErrors([])
    api.get<VersionedDoc<T>>(`/api/env/${envId}/config`)
      .then((doc) => { setData(doc.data); setVersion(doc.version) })
      .finally(() => setLoading(false))
  }, [envId])

  useEffect(reload, [reload])

  const save = useCallback(async (next: T) => {
    setErrors([]); setConflict(false)
    try {
      const doc = await api.put<VersionedDoc<T>>(`/api/env/${envId}/config`, { data: next, version })
      setData(doc.data); setVersion(doc.version)
      setToast('Saved'); setTimeout(() => setToast(null), 2000)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true)
      else if (e instanceof ApiError && e.status === 422) setErrors(e.messages ?? ['Invalid configuration'])
      else throw e
    }
  }, [envId, version])

  return { data, version, loading, conflict, errors, toast, reload, save }
}
```

- [ ] **Step 11: Commit (sections come next; shell references them, so they must exist to typecheck — create stubs now)**

Create minimal stub sections so the shell compiles; they are fully implemented in Tasks 11–12.

`config-manager-web/web/src/sections/GeneralSection.tsx` (stub):
```tsx
export function GeneralSection(_: { envId: string; canWrite: boolean }) { return <div className="card">General</div> }
```
`config-manager-web/web/src/sections/ProvidersSection.tsx` (stub):
```tsx
export function ProvidersSection(_: { envId: string; canWrite: boolean }) { return <div className="card">Providers</div> }
```

Run: `npx vitest run test/api.test.ts` (PASS) and `npm run typecheck` (no errors).

```bash
git add config-manager-web/web/src config-manager-web/web/test/setup.ts config-manager-web/web/test/api.test.ts
git commit -m "feat(web-config): frontend scaffold — theme, api client, auth gate, app shell"
```

---

## Task 11: General section

**Files:**
- Modify: `config-manager-web/web/src/sections/GeneralSection.tsx` (replace stub)
- Test: `config-manager-web/web/test/GeneralSection.test.tsx`

- [ ] **Step 1: Write the failing component test**

`config-manager-web/web/test/GeneralSection.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GeneralSection } from '../src/sections/GeneralSection.js'

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](url, init)))
}

describe('GeneralSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads current config and saves edits with the version', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'old' }, version: 'v1' }), { status: 200 }),
      (_u, init) => { calls.push(init!); return new Response(JSON.stringify({ data: { defaultModel: 'new' }, version: 'v2' }), { status: 200 }) },
    ])
    render(<GeneralSection envId="dev" canWrite={true} />)
    const input = await screen.findByLabelText('Default model')
    expect((input as HTMLInputElement).value).toBe('old')
    await userEvent.clear(input)
    await userEvent.type(input, 'new')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ version: 'v1', data: { defaultModel: 'new' } })
  })

  it('shows a conflict banner on 409', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 }),
      () => new Response(JSON.stringify({ error: 'version conflict' }), { status: 409 }),
    ])
    render(<GeneralSection envId="dev" canWrite={true} />)
    await screen.findByLabelText('Default model')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on the server/i)
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<GeneralSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Default model')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/GeneralSection.test.tsx`
Expected: FAIL — the stub renders no fields.

- [ ] **Step 3: Implement `config-manager-web/web/src/sections/GeneralSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface GeneralConfig {
  defaultProvider?: string
  defaultModel?: string
  maxInputLength?: number
  [k: string]: unknown
}

export function GeneralSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<GeneralConfig>(envId)
  const [form, setForm] = useState<GeneralConfig>({})
  useEffect(() => { if (cfg.data !== null) setForm(cfg.data) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const set = (k: keyof GeneralConfig, v: string) =>
    setForm(prev => ({ ...prev, [k]: v === '' ? undefined : v }))

  return (
    <div className="card">
      <h2>General</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && (
        <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>
      )}
      <Field label="Default provider" htmlFor="defaultProvider">
        <TextInput id="defaultProvider" value={String(form.defaultProvider ?? '')}
          disabled={!canWrite} onChange={(e) => set('defaultProvider', e.target.value)} />
      </Field>
      <Field label="Default model" htmlFor="defaultModel">
        <TextInput id="defaultModel" value={String(form.defaultModel ?? '')}
          disabled={!canWrite} onChange={(e) => set('defaultModel', e.target.value)} />
      </Field>
      <Field label="Max input length" htmlFor="maxInputLength">
        <TextInput id="maxInputLength" value={String(form.maxInputLength ?? '')}
          disabled={!canWrite} onChange={(e) => setForm(prev => ({ ...prev, maxInputLength: e.target.value === '' ? undefined : Number(e.target.value) }))} />
      </Field>
      <Button disabled={!canWrite} onClick={() => cfg.save(form)}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
```

Note: the section preserves unknown keys it didn't render (it spreads `cfg.data` into `form` and only overwrites the fields it edits), so saving General does not drop Providers or other config the user can't see in this section.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/GeneralSection.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/GeneralSection.tsx config-manager-web/web/test/GeneralSection.test.tsx
git commit -m "feat(web-config): General section (load/edit/save + conflict + RBAC)"
```

---

## Task 12: Providers section

**Files:**
- Modify: `config-manager-web/web/src/sections/ProvidersSection.tsx` (replace stub)
- Test: `config-manager-web/web/test/ProvidersSection.test.tsx`

- [ ] **Step 1: Write the failing component test**

`config-manager-web/web/test/ProvidersSection.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProvidersSection } from '../src/sections/ProvidersSection.js'

const KNOWN = ['google', 'openai', 'anthropic', 'mistral', 'groq']

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](url, init)))
}

describe('ProvidersSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders a toggle per known provider reflecting enabled state', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: { providers: { google: { enabled: true } } }, version: 'v1' }), { status: 200 })])
    render(<ProvidersSection envId="dev" canWrite={true} />)
    for (const p of KNOWN) expect(await screen.findByLabelText(p)).toBeInTheDocument()
    expect((await screen.findByLabelText('google') as HTMLInputElement).checked).toBe(true)
    expect((await screen.findByLabelText('openai') as HTMLInputElement).checked).toBe(false)
  })

  it('saves the providers map preserving other config keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep-me', providers: { google: { enabled: true } } }, version: 'v1' }), { status: 200 }),
      (_u, init) => { calls.push(init!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<ProvidersSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByLabelText('openai'))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep-me')               // untouched key preserved
    expect(body.data.providers.openai.enabled).toBe(true)        // toggled on
    expect(body.data.providers.google.enabled).toBe(true)        // unchanged
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ProvidersSection.test.tsx`
Expected: FAIL — the stub renders no toggles.

- [ ] **Step 3: Implement `config-manager-web/web/src/sections/ProvidersSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Toggle } from '../components/Toggle.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

const KNOWN_PROVIDERS = ['google', 'openai', 'anthropic', 'mistral', 'groq'] as const

interface ProvidersConfig {
  providers?: Record<string, { enabled?: boolean }>
  [k: string]: unknown
}

export function ProvidersSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<ProvidersConfig>(envId)
  const [providers, setProviders] = useState<Record<string, { enabled?: boolean }>>({})
  useEffect(() => { if (cfg.data !== null) setProviders(cfg.data.providers ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const toggle = (name: string, enabled: boolean) =>
    setProviders(prev => ({ ...prev, [name]: { ...prev[name], enabled } }))

  const onSave = () => {
    const base = cfg.data ?? {}
    cfg.save({ ...base, providers })   // preserve all other keys
  }

  return (
    <div className="card">
      <h2>Providers</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && (
        <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>
      )}
      {KNOWN_PROVIDERS.map(name => (
        <div key={name} className="field">
          <Toggle id={name} label={name} checked={providers[name]?.enabled === true}
            onChange={(v) => toggle(name, v)} />
        </div>
      ))}
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ProvidersSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/ProvidersSection.tsx config-manager-web/web/test/ProvidersSection.test.tsx
git commit -m "feat(web-config): Providers section (toggles, preserves other config keys)"
```

---

## Task 13: Plan-1 verification

**Files:** none (verification only)

- [ ] **Step 1: Server suite + typecheck**

Run (from `config-manager-web/server/`): `npx vitest run && npm run typecheck`
Expected: all server tests pass (config, environments, config-store, audit-log, validation, rbac, oidc, auth-routes, config-routes); no type errors.

- [ ] **Step 2: Web suite + typecheck**

Run (from `config-manager-web/web/`): `npx vitest run && npm run typecheck`
Expected: all web tests pass (api, GeneralSection, ProvidersSection); no type errors.

- [ ] **Step 3: Production build smoke**

Run (from `config-manager-web/web/`): `npm run build`
Expected: Vite build succeeds (dist/ emitted).
Run (from `config-manager-web/server/`): `npm run build`
Expected: tsc build succeeds (dist/ emitted).

- [ ] **Step 4: Final commit if anything changed**

```bash
git status
# commit any build-config fixes discovered during verification
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan 1 portion):** placement (`config-manager-web/`, Task 1), OIDC auth (Task 8 + auth-routes Task 9), RBAC with per-env overrides (Task 7 + enforced in config-routes Task 9), environments (Task 3), config store + optimistic 409 (Task 4 + Task 9), validation→422 via `freerouter` (Task 6 + Task 9), audit log (Task 5 + recorded in Task 9), Accenture theme (Task 10), env switcher + auth gate + role-aware UI (Task 10), General + Providers sections with conflict handling (Tasks 11–12). Remaining sections, BYOK, pricing-fetch, candidates, audit view, e2e, and Python-tool deletion are explicitly deferred to later plans.
- **Type consistency:** `VersionedDoc<T>` shape (`{data,version}`) is identical server (`types.ts`) and web (`types.ts`); routes return it from `JsonFileStore.read/write`; the web `useConfig` consumes it. `Role` is `'admin'|'viewer'` on both sides. `SessionUser` (`{subject,name,groups}`) is what `/auth/me` returns and what the web `MeResponse` expects. The config `PUT` contract `{data, version}` matches between `config-routes.ts`, `useConfig.save`, and both section tests.
- **No placeholders:** every code step contains complete code; the two section stubs in Task 10 are explicitly replaced in Tasks 11–12.
- **Core prerequisite (Task 0):** the web manager's validation reuse is only correct after `freerouter`'s two known-key lists are reconciled with `RouterConfig` and the dist is rebuilt. Task 0 does this in the core with regression tests; every later task that links `freerouter` assumes the rebuilt dist. `validateConfig`'s result shape is confirmed `{ valid, errors: string[], warnings: string[] }`, with unknown keys in `warnings` only — so the `validation.ts` adapter consumes `validateConfigKeys` for key typos and `validateConfig.errors` for structural rejection, with no duplication.
