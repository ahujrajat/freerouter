# Web Config Manager — Plan 5: E2E + Decommission the Python Tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the web config manager: (1) serve the built SPA from the Fastify server (single-origin, deployable); (2) add Playwright end-to-end tests driving a real browser against the assembled stack with a fake OIDC provider; (3) **after the web tool is verified working, delete the Python `config-manager/`** and update every reference to it.

**Architecture:** The server gains optional static SPA serving (`@fastify/static` + SPA fallback) gated by `WEB_DIST_DIR`, so one origin serves both API and UI (cookies/session work without CORS). An e2e harness boots `buildApp(...)` with a **FakeOidc** that auto-completes login, temp per-environment fixture files, a `local` key backend, and fake sidecar/pricing — then serves `web/dist`. Playwright drives Chromium through real flows. Decommission removes the Python tool and rewrites the README/FAQ/source comments to point at `config-manager-web/`.

**Tech Stack:** Same as Plans 1–4 + `@fastify/static` (server), `@playwright/test` (web dev dep).

**Prerequisite:** Plans 1–4 merged and green (server 80, web 33; full parity). Work from `config-manager-web/`.

This is **Plan 5 — the final plan.** It ends with the Python tool removed and the web manager as the sole config manager.

---

## File Structure

```
config-manager-web/server/src/
  app.ts                       # MODIFY: optional static SPA serving (WEB_DIST_DIR) + SPA fallback
  config.ts, types.ts          # MODIFY: optional webDistDir from WEB_DIST_DIR
config-manager-web/server/test/
  static-serving.test.ts       # NEW
config-manager-web/web/
  package.json                 # MODIFY: add @playwright/test + e2e scripts
  playwright.config.ts         # NEW
  e2e/harness.ts               # NEW: boots the full stack with FakeOidc + fixtures, serves web/dist
  e2e/app.spec.ts              # NEW: login, edit+save+persist, BYOK set, candidate optimize
config-manager-web/server/package.json  # MODIFY: add @fastify/static

# Decommission (repo root):
config-manager/                # DELETE (entire Python tool)
README.md, docs/FAQ.md         # MODIFY: replace Python-tool sections with web manager
src/finops/pricing-source.ts   # MODIFY: update stale "mirror of config-manager/..." comments
src/config.ts                  # MODIFY: "config-manager GUI" -> "web config manager"
src/optimization/fingerprint-store.ts  # MODIFY: same comment update
```

---

## Task 1: Serve the built SPA from the server

**Files:**
- Modify: `config-manager-web/server/src/types.ts` (+`webDistDir?`), `config-manager-web/server/src/config.ts` (parse `WEB_DIST_DIR`), `config-manager-web/server/src/app.ts` (static + SPA fallback), `config-manager-web/server/package.json` (+`@fastify/static`)
- Test: `config-manager-web/server/test/static-serving.test.ts`
- Modify: `config-manager-web/server/test/helpers.ts` (allow passing `webDistDir` to `buildTestApp`)

- [ ] **Step 1: Add the dep**

Add to `config-manager-web/server/package.json` dependencies:
```json
    "@fastify/static": "^7.0.4",
```
Run install (NETWORK — sandbox override for this command only): from `config-manager-web/` run `npm install`.

- [ ] **Step 2: Write the failing test**

`config-manager-web/server/test/static-serving.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestApp } from './helpers.js'

describe('static SPA serving', () => {
  let webDir: string
  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), 'fr-web-'))
    mkdirSync(join(webDir, 'assets'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root">APP</div>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)')
  })
  afterEach(() => rmSync(webDir, { recursive: true, force: true }))

  it('serves index.html at /', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('APP')
    await app.close()
  })

  it('serves built assets', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('SPA fallback: unknown non-API path returns index.html (not 404)', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/some/client/route' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('APP')
    await app.close()
  })

  it('unknown /api path still 404s (not the SPA)', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('with no webDistDir, / is not served (404)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/static-serving.test.ts`
Expected: FAIL — `buildTestApp` doesn't accept `webDistDir`; no static serving.

- [ ] **Step 4: Add `webDistDir` to config + AppDeps + helper**

In `src/types.ts` `ServerConfig`, add `webDistDir?: string`.
In `src/config.ts`, add to the returned object: `...(env.WEB_DIST_DIR !== undefined && { webDistDir: env.WEB_DIST_DIR })`.
In `src/app.ts` `AppDeps`, add `webDistDir?: string`.
In `test/helpers.ts` `buildTestApp(opts)`, accept `opts.webDistDir` and pass it into the `deps` object: `...(opts.webDistDir !== undefined && { webDistDir: opts.webDistDir })`.

- [ ] **Step 5: Add static serving + SPA fallback in `src/app.ts`**

After all route plugins are registered, add (only when `deps.webDistDir` is set):

```ts
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
// ...
  if (deps.webDistDir !== undefined) {
    await app.register(fastifyStatic, { root: deps.webDistDir, wildcard: false })
    // SPA fallback: any GET that isn't an API/auth route and wasn't a static file → index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/auth/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }
```

Note: `@fastify/static` with `wildcard: false` serves real files and lets the `notFoundHandler` handle the rest (the SPA fallback). API/auth 404s stay JSON 404s. `reply.sendFile` is added by the plugin.

- [ ] **Step 6: Run the test + suite + typecheck**

Run: `npx vitest run test/static-serving.test.ts && npx vitest run && npm run typecheck`
Expected: all pass; clean.

- [ ] **Step 7: Wire `webDistDir` in `src/server.ts`**

Add `...(cfg.webDistDir !== undefined && { webDistDir: cfg.webDistDir })` to the `buildApp({...})` deps object so a production deployment with `WEB_DIST_DIR=.../web/dist` serves the SPA.

- [ ] **Step 8: Commit**

```bash
git add config-manager-web/server/src/types.ts config-manager-web/server/src/config.ts config-manager-web/server/src/app.ts config-manager-web/server/src/server.ts config-manager-web/server/package.json config-manager-web/package-lock.json config-manager-web/server/test/helpers.ts config-manager-web/server/test/static-serving.test.ts
git commit -m "feat(web-config): serve built SPA from server (static + SPA fallback)"
```

---

## Task 2: Playwright harness

**Files:**
- Modify: `config-manager-web/web/package.json` (+`@playwright/test`, e2e scripts)
- Create: `config-manager-web/web/playwright.config.ts`, `config-manager-web/web/e2e/harness.ts`

- [ ] **Step 1: Add Playwright + scripts**

Add to `config-manager-web/web/package.json` devDependencies:
```json
    "@playwright/test": "^1.45.0",
```
Add scripts:
```json
    "e2e": "playwright test",
    "e2e:install": "playwright install chromium"
```
Run install (NETWORK — sandbox override): from `config-manager-web/` run `npm install`.

- [ ] **Step 2: Create the e2e harness `config-manager-web/web/e2e/harness.ts`**

This boots the real server with an auto-login FakeOidc, temp fixtures, a local key backend, and fake sidecar/pricing, and serves the built SPA from `web/dist`. It is started by Playwright's `webServer`.

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildApp } from '../../server/src/app.js'
import { EnvironmentRegistry } from '../../server/src/environments.js'
import { RoleResolver } from '../../server/src/auth/rbac.js'
import { AuditLog } from '../../server/src/store/audit-log.js'
import { KeyBackendRegistry } from '../../server/src/byok/registry.js'
import { LocalKeyBackend } from '../../server/src/byok/local-backend.js'
import type { OidcProvider, AuthRequest, Claims } from '../../server/src/auth/oidc.js'
import type { PricingFetcher } from '../../server/src/pricing/pricing-fetcher.js'
import type { SidecarClient } from '../../server/src/optimization/sidecar-client.js'

// FakeOidc: authUrl redirects straight back to the callback with the issued state,
// so /auth/login completes the loop without a real IdP.
class FakeOidc implements OidcProvider {
  authUrl(req: AuthRequest): string { return `${req.redirectUri}?code=fake&state=${req.state}` }
  async exchange(): Promise<Claims> { return { sub: 'e2e-admin', name: 'E2E Admin', groups: ['fin-admins'] } }
}

const fakePricing: PricingFetcher = { async fetch() { return { google: { 'gemini-2.5-flash': { input: 0.075, output: 0.3 } } } } }
const fakeSidecar: SidecarClient = { async optimize(r) { return { template: `OPTIMIZED ${r.classSignature}`, qualityScore: 0.9, predictedSavingsUsd: 0.05 } } }

export async function startHarness(port: number): Promise<{ close: () => Promise<void>; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fr-e2e-'))
  const paths = {
    config: join(dir, 'config.json'), rules: join(dir, 'rules.json'), env: join(dir, '.env'),
    pricing: join(dir, 'pricing.json'), optimizedStore: join(dir, 'opt.json'),
    candidates: join(dir, 'cand.json'), byok: join(dir, 'byok.json'),
  }
  const envFile = join(dir, 'environments.json')
  writeFileSync(envFile, JSON.stringify([{ id: 'dev', label: 'Development', paths }]))
  // Seed a candidate so the Candidates e2e has a row to optimize.
  writeFileSync(paths.candidates, JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 7, totalCostUsd: 0.3, lastSeen: 1, estPredictedSavingsUsd: 0.06, estBreakEvenReqs: 5, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }]))

  const webDist = resolve(import.meta.dirname, '..', 'dist')
  const app = await buildApp({
    sessionSecret: 'e'.repeat(32),
    oidc: new FakeOidc(),
    environments: EnvironmentRegistry.load(envFile),
    roles: new RoleResolver({ defaults: { 'fin-admins': 'admin', 'fin-viewers': 'viewer' } }),
    audit: new AuditLog(join(dir, 'audit.jsonl')),
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    afterLoginRedirect: '/',
    keyBackends: new KeyBackendRegistry({ local: new LocalKeyBackend('a'.repeat(64)) }),
    pricingFetcher: fakePricing,
    sidecar: fakeSidecar,
    webDistDir: webDist,
  })
  await app.listen({ host: '127.0.0.1', port })
  return { close: () => app.close(), dir }
}

// Entry point for Playwright's webServer command: `tsx e2e/harness.ts`
if (process.argv[1] !== undefined && process.argv[1].endsWith('harness.ts')) {
  const port = Number(process.env.E2E_PORT ?? '7799')
  startHarness(port).then(() => {
    // eslint-disable-next-line no-console
    console.log(`[e2e] harness listening on ${port}`)
  }).catch((e) => { console.error(e); process.exit(1) })
}
```

Note: the harness imports server `.ts` sources directly and is run via `tsx`; ensure `tsx` is available (it is a server devDep; add it to web devDeps too if Playwright's webServer can't resolve it — `tsx` can be added to `config-manager-web/web/package.json` devDependencies). The server must build its SPA first (`web` `npm run build` produces `web/dist`).

- [ ] **Step 3: Create `config-manager-web/web/playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? '7799')

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    command: `node --import tsx e2e/harness.ts`,
    url: `http://127.0.0.1:${PORT}/auth/me`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT) },
    // /auth/me returns 401 before login — treat any HTTP response as "up".
    ignoreHTTPSErrors: true,
  },
})
```

Note: Playwright's `webServer.url` readiness probe treats a 2xx/3xx/4xx as "server up". `/auth/me` returns 401 (server is up) — acceptable. If your Playwright version only accepts 2xx for readiness, point `url` at `/` (the SPA fallback returns 200 once `web/dist` exists).

- [ ] **Step 4: Commit the harness/config (specs come next)**

```bash
git add config-manager-web/web/package.json config-manager-web/package-lock.json config-manager-web/web/playwright.config.ts config-manager-web/web/e2e/harness.ts
git commit -m "test(web-config): Playwright harness (full stack, fake OIDC, serves SPA)"
```

---

## Task 3: E2E specs

**Files:**
- Create: `config-manager-web/web/e2e/app.spec.ts`

- [ ] **Step 1: Write the specs**

`config-manager-web/web/e2e/app.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

// The SPA's AuthGate redirects unauthenticated users to /auth/login, which
// (via FakeOidc) round-trips through /auth/callback and lands back on / signed in.
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/auth/login')
  await page.waitForURL('**/')
  await expect(page.getByText('E2E Admin')).toBeVisible()
}

test('signs in and shows the app shell with the environment', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('link', { name: 'General' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'BYOK Keys' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Candidates' })).toBeVisible()
})

test('edits General and the value persists across reload', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'General' }).click()
  const model = page.getByLabel('Default model')
  await model.fill('gemini-2.5-flash')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.reload()
  await page.getByRole('link', { name: 'General' }).click()
  await expect(page.getByLabel('Default model')).toHaveValue('gemini-2.5-flash')
})

test('sets a BYOK key and sees the masked last4 (never the secret)', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'BYOK Keys' }).click()
  await page.getByRole('button', { name: 'Set key' }).click()
  await page.getByLabel('Provider').fill('openai')
  await page.getByLabel('Secret').fill('sk-secret-4242')
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.getByText('openai')).toBeVisible()
  await expect(page.getByText(/4242/)).toBeVisible()
  await expect(page.getByText('sk-secret-4242')).toHaveCount(0)
})

test('optimizes a candidate and the status flips to optimized', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Candidates' }).click()
  await expect(page.getByText('gpt-4o')).toBeVisible()
  await page.getByRole('button', { name: 'Optimize' }).click()
  await expect(page.getByText('optimized')).toBeVisible()
})
```

- [ ] **Step 2: Build the SPA, install the browser, run the specs**

The harness serves `web/dist`, so build first. Browser download + launch need NETWORK and a working Chromium — run these with the sandbox override.

Run (from `config-manager-web/web/`):
```
npm run build              # produce web/dist
npm run e2e:install        # playwright install chromium  (network; sandbox override)
npm run e2e                # run the specs (sandbox override)
```
Expected: 4 specs pass.

If Chromium cannot be installed or launched in this environment (sandbox/display restrictions), report the exact failure as DONE_WITH_CONCERNS — the specs + harness are still committed as artifacts, and the web tool is independently verified by the server (80) + web unit (33) suites. Do NOT fake a pass.

- [ ] **Step 3: Commit**

```bash
git add config-manager-web/web/e2e/app.spec.ts
git commit -m "test(web-config): Playwright e2e specs (login, edit/persist, BYOK, candidate optimize)"
```

---

## Task 4: Decommission the Python `config-manager/`

Only proceed once Tasks 1–3 are complete and the web tool is verified (server + web unit suites green; e2e passing or its environment limitation documented). This is the agreed final step.

**Files:**
- Delete: `config-manager/` (entire directory)
- Modify: `README.md`, `docs/FAQ.md`, `src/finops/pricing-source.ts`, `src/config.ts`, `src/optimization/fingerprint-store.ts`

- [ ] **Step 1: Delete the Python tool**

Run (from repo root): `git rm -r config-manager`
Expected: removes `config-manager/app.py`, `finrouter_admin.py`, `auth.py`, `byok_io.py`, `candidates_io.py`, `config_io.py`, `pricing_fetcher.py`, `prefs.py`, `validators.py`, `test_candidates_io.py`, etc.

- [ ] **Step 2: Update `README.md`**

Replace the standalone-Python-manager section (around the lines describing `python3 config-manager/finrouter_admin.py`) with a description of the web manager. Find the block beginning "For operators who'd rather click than hand-edit JSON, FinRouter ships an **optional, fully standalone** desktop configuration manager at [config-manager/]..." and replace it with:

```markdown
For operators who'd rather click than hand-edit JSON, FinRouter has an **optional, fully standalone** web configuration manager at [config-manager-web/](config-manager-web/). It is deliberately excluded from the published npm package (the `files: ["dist"]` allowlist ships only compiled router code), so the runtime has zero dependency on it. It is a deployed, multi-user app (Node/TypeScript + Fastify API, React/Vite UI) with OIDC SSO, role-based access control, multiple environments, optimistic-locked config editing, write-only BYOK (local-encrypted or Vault/AWS/Azure/GCP key managers), pricing fetch, an auto-optimization candidates panel, and an audit log.

```bash
cd config-manager-web
npm install
npm run build              # build the SPA (web/dist) and the server
# configure OIDC + environments via env vars (see config-manager-web/README.md), then:
WEB_DIST_DIR=./web/dist npm run --workspace server start
```
```
Also update line ~522: change "config-manager → Optimization tab" to "config-manager-web → Optimization section".

- [ ] **Step 3: Update `docs/FAQ.md`**

In the capability table row and Section 8 (both reference the Python Tkinter app at `config-manager/`), replace the descriptions with the web manager. Concretely:
- Table row: change "Standalone Python desktop app (Tkinter, stdlib-only) at [`config-manager/`]..." to "Standalone web app (Node/TS + Fastify API, React/Vite UI) at [`config-manager-web/`](../config-manager-web/). OIDC SSO + RBAC, multi-environment, optimistic-locked editing, write-only BYOK, pricing fetch, candidates, audit. Excluded from the npm package."
- Section 8 prose: replace the "written in Python with Tkinter" description with the web manager's (deployed multi-user Node/React app), keeping the "zero coupling / deleting it breaks nothing / excluded from dist" guarantees. Update the `python3 config-manager/finrouter_admin.py ...` command examples to the `config-manager-web` build/run commands shown in README Step 2.

- [ ] **Step 4: Update stale source comments**

- `src/finops/pricing-source.ts` lines ~142, ~164, ~211: these say the transforms are mirrored in `config-manager/pricing_fetcher.py`. That Python file no longer exists; the web manager reuses these very functions. Update the comments — e.g. change "Mirror of `config-manager/pricing_fetcher.py::_transform_litellm`. Keep the two implementations in sync —" to "Used by the web config manager (`config-manager-web`) for its pricing-fetch feature." Remove the "keep in sync" note (there is no second implementation now).
- `src/config.ts` lines ~106, ~112: change "config-manager GUI" → "config-manager-web UI".
- `src/optimization/fingerprint-store.ts` lines ~69, ~96: change "config-manager GUI" → "config-manager-web".

- [ ] **Step 5: Verify no dangling references remain**

Run (from repo root):
```
grep -rIn "config-manager/" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=config-manager-web --exclude-dir=docs/superpowers . || echo "no stray refs"
grep -rIln "finrouter_admin\|config-manager\b" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=config-manager-web --exclude-dir=docs/superpowers . | grep -v config-manager-web || echo "clean"
```
Expected: no references to the deleted `config-manager/` path remain (matches under `config-manager-web/` and `docs/superpowers/` historical plans/specs are fine). Fix any stragglers.

- [ ] **Step 6: Confirm the core repo still builds + tests pass (deletion touched only docs/comments in src)**

Run (from repo root): `npx tsc --noEmit && npx vitest run --exclude '**/cli.test.ts'`
Expected: clean; all pass (the src comment edits are non-functional; deleting `config-manager/` doesn't affect `src/` or `tests/`). Note: `tests/` had no dependency on the Python tool. (`config-manager/test_candidates_io.py` was a Python test, removed with the directory.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove Python config-manager (superseded by config-manager-web); update docs + comments"
```

---

## Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: config-manager-web — full server + web suites + builds**

Run (from `config-manager-web/server/`): `npx vitest run && npm run typecheck && npm run build` → all pass, `dist/server.js` emitted; `rm -rf dist`.
Run (from `config-manager-web/web/`): `npx vitest run && npm run typecheck && npm run build` → all pass, Vite build OK, `find src -name '*.js'` empty.

- [ ] **Step 2: E2E (if runnable in this environment)**

Run (from `config-manager-web/web/`): `npm run build && npm run e2e` (sandbox override).
Expected: 4 specs pass. If the browser can't launch here, record the limitation (the specs/harness are committed; unit+integration suites verify the tool).

- [ ] **Step 3: Core repo sanity**

Run (from repo root): `npx tsc --noEmit && npx vitest run --exclude '**/cli.test.ts'` → clean; all pass.
Confirm `config-manager/` is gone: `test ! -d config-manager && echo "python tool removed"`.

- [ ] **Step 4: Final commit if anything changed**

```bash
git status
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan-5 portion):** static SPA serving for single-origin deploy + e2e (Task 1); Playwright harness booting the real stack with FakeOidc + fixtures + local backend + fake sidecar/pricing (Task 2); e2e specs for login, edit/persist, BYOK set (masked, secret never shown), candidate optimize (Task 3); deletion of the Python `config-manager/` with all README/FAQ/source-comment references updated (Task 4); final verification (Task 5). After this plan, `config-manager-web/` is the sole config manager.
- **Decommission gate:** the agreed condition was "delete the Python tool after the web tool is tested and verified working." That is satisfied by the cumulative server (80+) and web (33+) unit/integration suites plus the authored e2e. If Chromium can't run in this sandbox, the deletion still stands on the unit/integration coverage — but the e2e artifacts remain for environments that can run them.
- **Single-origin e2e:** serving the SPA from the server (Task 1) means the browser hits one origin, so the session cookie (httpOnly, SameSite=Lax) works without CORS. The FakeOidc `authUrl` redirects straight to `/auth/callback` with the issued `state`, so `/auth/login` completes login without a real IdP.
- **No new runtime coupling:** `@fastify/static` is gated by `WEB_DIST_DIR`; without it the server behaves exactly as before (the "no webDistDir → 404 at /" test guards this), so all prior tests are unaffected.
- **Verification after deletion:** deleting `config-manager/` only affects that directory; `src/` edits are comment-only and `tsc --noEmit` + the core vitest suite confirm nothing functional changed. The pre-existing `cli.test.ts` EACCES failures remain excluded.
