# Web Config Manager — Plan 4: Pricing Fetch + Candidates + Audit View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three integration features that complete config-manager parity: (1) **server-side pricing fetch** from LiteLLM/OpenRouter (reusing `finrouter`'s pricing sources) feeding a "Fetch" dialog in the Pricing Overrides section; (2) an **auto-optimization candidates** panel that lists candidates and triggers the GEPA sidecar `/optimize` server-side, writing the optimized-prompt store and updating candidate status; (3) an **Audit viewer** of the admin audit log.

**Architecture:** Pricing fetch and sidecar optimization run on the server (keeps source URLs / sidecar token off the browser, avoids CORS). Both external dependencies sit behind injectable interfaces — `PricingFetcher` and `SidecarClient` — so routes are unit-tested with fakes (real network is not exercised in CI). Candidates/optimized data reuse the per-environment files from Plan 1 (`env.paths.candidates`, `env.paths.optimizedStore`) via `JsonFileStore` (array-normalized like rules). The audit route reads the existing `AuditLog`. Each new route plugin registers its **own** auth `preHandler` (Fastify hooks are plugin-scoped — established in Plan 3).

**Tech Stack:** Same as Plans 1–3. New external deps: none (pricing uses `finrouter`'s `liteLLMPricingSource`/`openRouterPricingSource`; sidecar uses `fetch`).

**Prerequisite:** Plans 1–3 merged and green (server 69, web 27). Work from `config-manager-web/`. Run server commands from `server/`, web from `web/`.

This is **Plan 4 of the sequence**. Playwright e2e + deletion of the Python `config-manager/` is Plan 5 (out of scope here).

---

## File Structure

```
config-manager-web/server/src/
  types.ts                          # MODIFY: add gepaSidecarUrl?/gepaSidecarToken? to ServerConfig
  config.ts                         # MODIFY: parse GEPA_SIDECAR_URL / GEPA_SIDECAR_TOKEN
  pricing/pricing-fetcher.ts        # NEW: PricingFetcher interface + LibraryPricingFetcher
  optimization/sidecar-client.ts    # NEW: SidecarClient interface + HttpSidecarClient + types
  routes/pricing-routes.ts          # NEW: GET /api/env/:id/pricing-fetch
  routes/candidates-routes.ts       # NEW: GET /api/env/:id/candidates, POST .../:fingerprint/optimize
  routes/audit-routes.ts            # NEW: GET /api/audit
  app.ts                            # MODIFY: AppDeps gets pricingFetcher + sidecar; register 3 route plugins
  server.ts                         # MODIFY: build real fetcher + sidecar client from config
config-manager-web/server/test/
  pricing-fetcher.test.ts, pricing-routes.test.ts, candidates-routes.test.ts,
  audit-routes.test.ts, helpers.ts (MODIFY: inject fake pricingFetcher + sidecar)

config-manager-web/web/src/
  types.ts                          # MODIFY: add CandidateRow, AuditRow, FetchedPricing types
  sections/PricingSection.tsx       # MODIFY: add "Fetch from source" dialog
  sections/CandidatesSection.tsx    # NEW
  sections/AuditSection.tsx         # NEW
  app/AppShell.tsx                  # MODIFY: add 'Candidates' + 'Audit' nav entries
config-manager-web/web/test/
  CandidatesSection.test.tsx, AuditSection.test.tsx, PricingSection.test.tsx (MODIFY)
```

---

## Task 1: Server config — GEPA sidecar URL/token

**Files:**
- Modify: `config-manager-web/server/src/types.ts`, `config-manager-web/server/src/config.ts`
- Test: `config-manager-web/server/test/config.test.ts` (extend)

- [ ] **Step 1: Extend the failing config test**

Append to `config-manager-web/server/test/config.test.ts`:

```ts
describe('loadServerConfig — GEPA sidecar', () => {
  const base = {
    OIDC_ISSUER: 'https://idp', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    OIDC_REDIRECT_URI: 'https://app/cb', SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/e.json', AUDIT_LOG_FILE: '/a.jsonl',
  }
  it('parses GEPA_SIDECAR_URL and token when present', () => {
    const cfg = loadServerConfig({ ...base, GEPA_SIDECAR_URL: 'http://127.0.0.1:8765', GEPA_SIDECAR_TOKEN: 'tok' })
    expect(cfg.gepaSidecarUrl).toBe('http://127.0.0.1:8765')
    expect(cfg.gepaSidecarToken).toBe('tok')
  })
  it('leaves them undefined when absent', () => {
    const cfg = loadServerConfig(base)
    expect(cfg.gepaSidecarUrl).toBeUndefined()
    expect(cfg.gepaSidecarToken).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `cfg.gepaSidecarUrl` does not exist.

- [ ] **Step 3: Add fields to `ServerConfig` in `src/types.ts`**

Add to the `ServerConfig` interface:
```ts
  gepaSidecarUrl?: string
  gepaSidecarToken?: string
```

- [ ] **Step 4: Parse them in `src/config.ts`**

In the returned object, after the BYOK spread, add (conditional-spread form, matching the file's pattern):
```ts
    ...(env.GEPA_SIDECAR_URL !== undefined && { gepaSidecarUrl: env.GEPA_SIDECAR_URL }),
    ...(env.GEPA_SIDECAR_TOKEN !== undefined && { gepaSidecarToken: env.GEPA_SIDECAR_TOKEN }),
```

- [ ] **Step 5: Run config test + suite + typecheck**

Run: `npx vitest run test/config.test.ts && npx vitest run && npm run typecheck`
Expected: all pass; clean.

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/server/src/types.ts config-manager-web/server/src/config.ts config-manager-web/server/test/config.test.ts
git commit -m "feat(web-config): GEPA sidecar URL/token server config"
```

---

## Task 2: Pricing fetcher + pricing-fetch route

**Files:**
- Create: `config-manager-web/server/src/pricing/pricing-fetcher.ts`, `config-manager-web/server/src/routes/pricing-routes.ts`
- Modify: `config-manager-web/server/src/app.ts` (AppDeps + register), `config-manager-web/server/test/helpers.ts` (inject fake fetcher)
- Test: `config-manager-web/server/test/pricing-fetcher.test.ts`, `config-manager-web/server/test/pricing-routes.test.ts`

- [ ] **Step 1: Write the failing fetcher test**

`config-manager-web/server/test/pricing-fetcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LibraryPricingFetcher } from '../src/pricing/pricing-fetcher.js'
import type { PricingSource } from 'finrouter'

function fakeSource(manifest: Record<string, unknown>): PricingSource {
  return { fetch: async () => manifest as never }
}

describe('LibraryPricingFetcher', () => {
  it('fetches the named source and returns the manifest', async () => {
    const f = new LibraryPricingFetcher({
      litellm: () => fakeSource({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } }),
      openrouter: () => fakeSource({}),
    })
    expect(await f.fetch('litellm')).toEqual({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } })
  })

  it('throws on an unknown source name', async () => {
    const f = new LibraryPricingFetcher({})
    await expect(f.fetch('nope')).rejects.toThrow(/unknown pricing source/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pricing-fetcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `config-manager-web/server/src/pricing/pricing-fetcher.ts`**

```ts
import type { PricingManifest, PricingSource } from 'finrouter'

export interface PricingFetcher {
  fetch(source: string): Promise<PricingManifest>
}

export type SourceFactory = () => PricingSource

/** Fetches pricing via injectable source factories (real ones wrap finrouter's
 *  liteLLMPricingSource/openRouterPricingSource; tests inject fakes). */
export class LibraryPricingFetcher implements PricingFetcher {
  constructor(private readonly sources: Record<string, SourceFactory>) {}
  async fetch(source: string): Promise<PricingManifest> {
    const factory = this.sources[source]
    if (factory === undefined) throw new Error(`[pricing] unknown pricing source: ${source}`)
    return factory().fetch()
  }
}
```

- [ ] **Step 4: Run to verify the fetcher test passes**

Run: `npx vitest run test/pricing-fetcher.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `pricingFetcher` to `AppDeps` + inject a fake in the test helper**

In `src/app.ts` `AppDeps`, add:
```ts
  pricingFetcher: import('./pricing/pricing-fetcher.js').PricingFetcher
```
In `test/helpers.ts`, import the type and add to the `deps` object in `buildTestApp` a fake that returns a fixed manifest:
```ts
import type { PricingFetcher } from '../src/pricing/pricing-fetcher.js'
// ...
const fakePricingFetcher: PricingFetcher = {
  async fetch() { return { openai: { 'gpt-4o': { input: 2.5, output: 10 } }, google: { 'gemini-2.5-flash': { input: 0.075, output: 0.3 } } } }
}
```
and `pricingFetcher: fakePricingFetcher,` in `deps`.

- [ ] **Step 6: Write the failing route test**

`config-manager-web/server/test/pricing-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('pricing-fetch route', () => {
  it('returns the fetched manifest filtered to configured providers', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    // Configure the dev env so only google is enabled.
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { providers: { google: { enabled: true }, openai: { enabled: false } } }, version: read.json().version } })
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/pricing-fetch?source=litellm', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const manifest = res.json()
    expect(manifest.google).toBeDefined()
    expect(manifest.openai).toBeUndefined()   // filtered out (not enabled)
    await app.close()
  })

  it('401 unauthenticated', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/pricing-fetch?source=litellm' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
```

- [ ] **Step 7: Create `config-manager-web/server/src/routes/pricing-routes.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore } from '../store/config-store.js'
import type { SessionUser, Environment } from '../types.js'

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerPricingRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, pricingFetcher } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  app.get('/api/env/:id/pricing-fetch', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env: Environment | undefined = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) === undefined) return reply.code(403).send({ error: 'forbidden' })
    const source = (req.query as { source?: string }).source ?? 'litellm'
    let manifest
    try { manifest = await pricingFetcher.fetch(source) }
    catch (err) { return reply.code(502).send({ error: (err as Error).message }) }
    // Filter to providers enabled in this environment's config.
    const cfg = new JsonFileStore<{ providers?: Record<string, { enabled?: boolean }> }>(env.paths.config).read().data
    const enabled = new Set(Object.entries(cfg.providers ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k))
    const filtered = enabled.size === 0 ? manifest
      : Object.fromEntries(Object.entries(manifest).filter(([provider]) => enabled.has(provider)))
    return reply.send(filtered)
  })
}
```

Note: the preHandler here only guards this plugin's routes (Fastify hooks are plugin-scoped — confirmed in Plan 3), so it must be declared in each route file. Same pattern applies to Tasks 3 and 4.

- [ ] **Step 8: Register the plugin in `src/app.ts`**

Add import + registration after `registerConfigRoutes`:
```ts
import { registerPricingRoutes } from './routes/pricing-routes.js'
// ...
  await app.register(registerPricingRoutes)
```

- [ ] **Step 9: Run route test + suite + typecheck**

Run: `npx vitest run test/pricing-routes.test.ts && npx vitest run && npm run typecheck`
Expected: all pass; clean. (The test's "filtered to configured providers" relies on the fake fetcher returning both `google` and `openai`, and the env config enabling only `google`.)

- [ ] **Step 10: Commit**

```bash
git add config-manager-web/server/src/pricing config-manager-web/server/src/routes/pricing-routes.ts config-manager-web/server/src/app.ts config-manager-web/server/test/helpers.ts config-manager-web/server/test/pricing-fetcher.test.ts config-manager-web/server/test/pricing-routes.test.ts
git commit -m "feat(web-config): server-side pricing fetch (LiteLLM/OpenRouter) filtered to enabled providers"
```

---

## Task 3: Sidecar client + candidates routes

**Files:**
- Create: `config-manager-web/server/src/optimization/sidecar-client.ts`, `config-manager-web/server/src/routes/candidates-routes.ts`
- Modify: `config-manager-web/server/src/app.ts` (AppDeps + register), `config-manager-web/server/test/helpers.ts` (inject fake sidecar)
- Test: `config-manager-web/server/test/candidates-routes.test.ts`

- [ ] **Step 1: Create the sidecar client interface + HTTP impl**

`config-manager-web/server/src/optimization/sidecar-client.ts`:

```ts
export interface OptimizeRequest {
  classSignature: string
  targetModel: string
  fallbackModel: string
  sample: { messages: { role: string; content: string }[]; model: string }
}

export interface OptimizeResult {
  template: string
  qualityScore: number
  predictedSavingsUsd: number
}

export interface SidecarClient {
  optimize(req: OptimizeRequest): Promise<OptimizeResult>
}

/** Calls the GEPA sidecar `/optimize` over HTTP. */
export class HttpSidecarClient implements SidecarClient {
  constructor(private readonly url: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async optimize(req: OptimizeRequest): Promise<OptimizeResult> {
    const resp = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token !== undefined && { Authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify(req),
    })
    if (!resp.ok) throw new Error(`sidecar /optimize failed: HTTP ${resp.status}`)
    const body = await resp.json() as { template: string; qualityScore?: number; predictedSavingsUsd?: number }
    return { template: body.template, qualityScore: body.qualityScore ?? 0, predictedSavingsUsd: body.predictedSavingsUsd ?? 0 }
  }
}
```

- [ ] **Step 2: Add `sidecar` to `AppDeps` + inject a fake in the test helper**

In `src/app.ts` `AppDeps`, add (optional — a deployment without a sidecar still runs):
```ts
  sidecar?: import('./optimization/sidecar-client.js').SidecarClient
```
In `test/helpers.ts`, add a fake recording optimizer and include it in deps:
```ts
import type { SidecarClient } from '../src/optimization/sidecar-client.js'
// ...
const fakeSidecar: SidecarClient = {
  async optimize(req) { return { template: `OPTIMIZED for ${req.classSignature}`, qualityScore: 0.9, predictedSavingsUsd: 0.05 } }
}
```
and `sidecar: fakeSidecar,` in `deps`.

- [ ] **Step 3: Write the failing candidates-routes test**

`config-manager-web/server/test/candidates-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { buildTestApp, cookieHeader, lastTempDir } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>, groups?: string[]): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('candidates routes', () => {
  it('lists candidates from the env candidates file', async () => {
    const { app, dir } = await buildTestApp({ withDir: true })
    const cookie = await login(app)
    writeFileSync(`${dir}/cand.json`, JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 5, totalCostUsd: 0.2, lastSeen: 1, estPredictedSavingsUsd: 0.05, estBreakEvenReqs: 4, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }]))
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/candidates', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0].fingerprint).toBe('eh:gpt-4o:ab')
    await app.close()
  })

  it('optimizes a candidate: calls sidecar, writes optimized store, flips status', async () => {
    const { app, dir } = await buildTestApp({ withDir: true })
    const cookie = await login(app)
    const cand = { fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 5, totalCostUsd: 0.2, lastSeen: 1, estPredictedSavingsUsd: 0.05, estBreakEvenReqs: 4, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }
    writeFileSync(`${dir}/cand.json`, JSON.stringify([cand]))
    const res = await app.inject({ method: 'POST', url: '/api/env/dev/candidates/eh:gpt-4o:ab/optimize', headers: { cookie }, payload: { targetModel: 'gpt-4o-mini' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('optimized')
    // optimized store written
    const opt = JSON.parse(require('node:fs').readFileSync(`${dir}/opt.json`, 'utf-8'))
    expect(opt[0]).toMatchObject({ fingerprint: 'eh:gpt-4o:ab', template: 'OPTIMIZED for eh:gpt-4o:ab', targetModel: 'gpt-4o-mini' })
    await app.close()
  })

  it('forbids a viewer from optimizing (403)', async () => {
    const { app } = await buildTestApp({ withDir: true, claims: { sub: 'v', name: 'V', groups: ['fin-viewers'] } })
    const cookie = await login(app)
    const res = await app.inject({ method: 'POST', url: '/api/env/dev/candidates/x/optimize', headers: { cookie }, payload: {} })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
```

Note: this test needs `buildTestApp` to optionally return the temp dir (so the test can seed `cand.json` and read `opt.json`). Update `buildTestApp` in `helpers.ts` to accept `{ withDir?: boolean }` and, when set, return `{ app, dir }`; otherwise return the app as before (preserve the existing call sites). Implement that in Step 4.

- [ ] **Step 4: Update `buildTestApp` to optionally expose the temp dir**

In `test/helpers.ts`, `makeTempEnv` already creates `dir`. Change `buildTestApp` so it captures that `dir` and, when `opts.withDir` is true, returns `{ app, dir }`; otherwise returns the `FastifyInstance` as today. Concretely: have `makeTempEnv` return `{ dir, environmentsFile }` (it already does), keep the `dir` in scope, and:
```ts
export async function buildTestApp(opts: { claims?: Claims; withDir?: boolean } = {}): Promise<any> {
  const { dir, environmentsFile } = makeTempEnv()
  // ... build deps + app exactly as now ...
  const app = buildApp(deps)
  return opts.withDir ? { app: await app, dir } : app
}
```
The candidate/optimized files for env `dev` are `${dir}/cand.json` and `${dir}/opt.json` (matching `makeTempEnv`'s `candidates`/`optimizedStore` paths — verify those filenames in `makeTempEnv` and use the same ones in the test; adjust the test's paths if `makeTempEnv` names them differently). Existing call sites that do `const app = await buildTestApp()` keep working because the default (no `withDir`) still returns the app. Export `lastTempDir` is not needed — remove that import from the test (it was a placeholder); use the returned `dir`.

- [ ] **Step 5: Correct the test imports**

In `candidates-routes.test.ts`, remove `lastTempDir` from the import (use the `{ app, dir }` return), and replace the `require('node:fs')` call with a top-level `import { writeFileSync, readFileSync } from 'node:fs'`. Use `readFileSync` for the optimized-store assertion.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/candidates-routes.test.ts`
Expected: FAIL — routes 404 / `buildTestApp` withDir not yet supported.

- [ ] **Step 7: Create `config-manager-web/server/src/routes/candidates-routes.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore } from '../store/config-store.js'
import type { SessionUser, Environment } from '../types.js'

interface Candidate {
  fingerprint: string; simhash: string; model: string; status: string
  sampleClassSignature?: string; estPredictedSavingsUsd?: number
}
interface OptimizedEntry {
  fingerprint: string; simhash: string; template: string
  qualityScore: number; predictedSavingsUsd: number; targetModel: string; optimizedAt: number
}

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined
const readArray = <T>(path: string): T[] => { const d = new JsonFileStore(path).read().data; return Array.isArray(d) ? d as T[] : [] }

export async function registerCandidatesRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit, sidecar } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  function resolve(req: FastifyRequest, reply: FastifyReply, needWrite: boolean): Environment | undefined {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) { reply.code(404).send({ error: 'unknown environment' }); return undefined }
    const role = roles.roleFor(user.groups, id)
    if (role === undefined) { reply.code(403).send({ error: 'forbidden' }); return undefined }
    if (needWrite && role !== 'admin') { reply.code(403).send({ error: 'forbidden' }); return undefined }
    return env
  }

  app.get('/api/env/:id/candidates', async (req, reply) => {
    const env = resolve(req, reply, false)
    if (env === undefined) return
    return reply.send(readArray<Candidate>(env.paths.candidates))
  })

  app.post('/api/env/:id/candidates/:fingerprint/optimize', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    if (sidecar === undefined) return reply.code(503).send({ error: 'no GEPA sidecar configured' })
    const fingerprint = decodeURIComponent((req.params as { fingerprint: string }).fingerprint)
    const candidates = readArray<Candidate>(env.paths.candidates)
    const cand = candidates.find(c => c.fingerprint === fingerprint)
    if (cand === undefined) return reply.code(404).send({ error: 'unknown candidate' })

    const body = req.body as { targetModel?: string }
    const targetModel = body?.targetModel ?? cand.model
    let result
    try {
      result = await sidecar.optimize({
        classSignature: cand.sampleClassSignature ?? cand.fingerprint,
        targetModel,
        fallbackModel: cand.model,
        sample: { messages: [{ role: 'user', content: '' }], model: cand.model },
      })
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message })
    }

    // Write optimized store (array; upsert by fingerprint).
    const store = new JsonFileStore<OptimizedEntry[]>(env.paths.optimizedStore)
    const existing = readArray<OptimizedEntry>(env.paths.optimizedStore)
    const entry: OptimizedEntry = {
      fingerprint: cand.fingerprint, simhash: cand.simhash, template: result.template,
      qualityScore: result.qualityScore, predictedSavingsUsd: result.predictedSavingsUsd,
      targetModel, optimizedAt: Date.now(),
    }
    const merged = [...existing.filter(e => e.fingerprint !== cand.fingerprint), entry]
    store.write(merged, store.read().version)

    // Flip candidate status to 'optimized' and persist the candidates file.
    cand.status = 'optimized'
    const candStore = new JsonFileStore<Candidate[]>(env.paths.candidates)
    candStore.write(candidates, candStore.read().version)

    audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'candidate:optimize', target: `candidate:${fingerprint}` })
    return reply.send(cand)
  })
}
```

- [ ] **Step 8: Register the plugin in `src/app.ts`**

```ts
import { registerCandidatesRoutes } from './routes/candidates-routes.js'
// ...
  await app.register(registerCandidatesRoutes)
```

- [ ] **Step 9: Run candidates test + suite + typecheck**

Run: `npx vitest run test/candidates-routes.test.ts && npx vitest run && npm run typecheck`
Expected: all pass; clean.

- [ ] **Step 10: Commit**

```bash
git add config-manager-web/server/src/optimization config-manager-web/server/src/routes/candidates-routes.ts config-manager-web/server/src/app.ts config-manager-web/server/test/helpers.ts config-manager-web/server/test/candidates-routes.test.ts
git commit -m "feat(web-config): candidates list + server-side sidecar optimize (writes optimized store)"
```

---

## Task 4: Audit view route

**Files:**
- Create: `config-manager-web/server/src/routes/audit-routes.ts`
- Modify: `config-manager-web/server/src/app.ts` (register)
- Test: `config-manager-web/server/test/audit-routes.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/audit-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('audit route', () => {
  it('returns recent audit records after a mutation', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'm' }, version: read.json().version } })
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const records = res.json()
    expect(Array.isArray(records)).toBe(true)
    expect(records[0]).toMatchObject({ action: 'config:save', environment: 'dev' })
    await app.close()
  })

  it('401 unauthenticated', async () => {
    const app = await buildTestApp()
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401)
    await app.close()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/audit-routes.test.ts`
Expected: FAIL — `/api/audit` 404.

- [ ] **Step 3: Create `config-manager-web/server/src/routes/audit-routes.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionUser } from '../types.js'

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const { audit } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  app.get('/api/audit', async (req, reply) => {
    const limit = Number((req.query as { limit?: string }).limit ?? '100')
    return reply.send(audit.recent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100))
  })
}
```

- [ ] **Step 4: Register the plugin in `src/app.ts`**

```ts
import { registerAuditRoutes } from './routes/audit-routes.js'
// ...
  await app.register(registerAuditRoutes)
```

- [ ] **Step 5: Run audit test + suite + typecheck**

Run: `npx vitest run test/audit-routes.test.ts && npx vitest run && npm run typecheck`
Expected: all pass; clean.

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/server/src/routes/audit-routes.ts config-manager-web/server/src/app.ts config-manager-web/server/test/audit-routes.test.ts
git commit -m "feat(web-config): audit view route (recent records)"
```

---

## Task 5: Pricing section — "Fetch from source" dialog

**Files:**
- Modify: `config-manager-web/web/src/sections/PricingSection.tsx`, `config-manager-web/web/src/types.ts`
- Test: `config-manager-web/web/test/PricingSection.test.tsx` (extend)

- [ ] **Step 1: Add a fetched-pricing type to `config-manager-web/web/src/types.ts`**

```ts
export type FetchedPricing = Record<string, Record<string, { input: number; output: number; cachedInput?: number }>>
```

- [ ] **Step 2: Write the failing test (append to `config-manager-web/web/test/PricingSection.test.tsx`)**

```tsx
it('fetches pricing from a source and merges a selected model into overrides', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  mockFetchSequence([
    () => new Response(JSON.stringify({ data: { pricingOverrides: {} }, version: 'v1' }), { status: 200 }), // initial config load
    (url) => { calls.push({ url }); return new Response(JSON.stringify({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } }), { status: 200 }) }, // pricing-fetch
    (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) }, // save
  ])
  render(<PricingSection envId="dev" canWrite={true} />)
  await userEvent.click(await screen.findByRole('button', { name: /fetch from source/i }))
  await userEvent.click(await screen.findByRole('button', { name: /^fetch$/i }))
  // select the fetched model + apply
  await userEvent.click(await screen.findByLabelText('gpt-4o'))
  await userEvent.click(screen.getByRole('button', { name: /apply selected/i }))
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(calls.some(c => c.url.includes('/pricing-fetch'))).toBe(true))
  const saveCall = calls.find(c => c.init?.method === 'PUT')!
  expect(JSON.parse(saveCall.init!.body as string).data.pricingOverrides['gpt-4o']).toMatchObject({ input: 2.5, output: 10 })
})
```

`mockFetchSequence` already exists in this test file (from Plan 2). If it isn't in scope for the new `it`, ensure it's defined at the describe level (it is).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/PricingSection.test.tsx`
Expected: FAIL — no "Fetch from source" button yet.

- [ ] **Step 4: Add the fetch dialog to `config-manager-web/web/src/sections/PricingSection.tsx`**

Add imports (if not present): `useState` is already used; add `api` from `../api.js` and `Toggle` from `../components/Toggle.js`, plus the `FetchedPricing` type from `../types.js`.

Inside the component, add fetch-dialog state and handlers, a "Fetch from source" button next to "Add override", and a second `Modal` that:
1. has a source `<select>` ('litellm'/'openrouter') + a "Fetch" button calling `GET /api/env/${envId}/pricing-fetch?source=...`,
2. renders the returned models as labelled checkboxes (flattened `provider/model` → use the model id as the label/key),
3. "Apply selected" merges the chosen `{input,output,cachedInput?}` into the section's `over` state keyed by model id, and closes the dialog.

Concrete additions (place alongside the existing override modal logic):

```tsx
  const [fetchOpen, setFetchOpen] = useState(false)
  const [source, setSource] = useState('litellm')
  const [fetched, setFetched] = useState<Record<string, Rate>>({})
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const runFetch = async () => {
    const manifest = await api.get<Record<string, Record<string, Rate>>>(`/api/env/${envId}/pricing-fetch?source=${source}`)
    const flat: Record<string, Rate> = {}
    for (const models of Object.values(manifest)) for (const [model, rate] of Object.entries(models)) flat[model] = rate
    setFetched(flat); setPicked({})
  }
  const applyFetched = () => {
    setOver(prev => {
      const next = { ...prev }
      for (const [model, on] of Object.entries(picked)) if (on && fetched[model] !== undefined) next[model] = fetched[model]!
      return next
    })
    setFetchOpen(false)
  }
```

Add the button (next to "Add override"):
```tsx
      {canWrite && <Button variant="ghost" onClick={() => { setFetchOpen(true); setFetched({}); }}>Fetch from source</Button>}
```

Add the dialog (after the existing override Modal):
```tsx
      <Modal open={fetchOpen} title="Fetch pricing" onClose={() => setFetchOpen(false)}
        footer={<Button onClick={applyFetched}>Apply selected</Button>}>
        <Field label="Source" htmlFor="pf-src">
          <select id="pf-src" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="litellm">LiteLLM</option><option value="openrouter">OpenRouter</option>
          </select>
        </Field>
        <Button onClick={runFetch}>Fetch</Button>
        <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
          {Object.entries(fetched).map(([model, r]) => (
            <div key={model} className="field">
              <Toggle id={`pf-${model}`} label={`${model} (in ${r.input} / out ${r.output})`} checked={picked[model] === true}
                onChange={(v) => setPicked(prev => ({ ...prev, [model]: v }))} />
            </div>
          ))}
        </div>
      </Modal>
```

(`Rate` is the section's existing interface `{ input; output; cachedInput? }`.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/PricingSection.test.tsx`
Expected: PASS (existing 2 + new 1 = 3).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/sections/PricingSection.tsx config-manager-web/web/src/types.ts config-manager-web/web/test/PricingSection.test.tsx
git commit -m "feat(web-config): Pricing section fetch-from-source dialog (LiteLLM/OpenRouter)"
```

---

## Task 6: Candidates section

**Files:**
- Create: `config-manager-web/web/src/sections/CandidatesSection.tsx`
- Modify: `config-manager-web/web/src/types.ts` (add `CandidateRow`)
- Test: `config-manager-web/web/test/CandidatesSection.test.tsx`

- [ ] **Step 1: Add `CandidateRow` to `config-manager-web/web/src/types.ts`**

```ts
export interface CandidateRow {
  fingerprint: string; model: string; count: number
  estPredictedSavingsUsd: number; status: string
}
```

- [ ] **Step 2: Write the failing test**

`config-manager-web/web/test/CandidatesSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CandidatesSection } from '../src/sections/CandidatesSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('CandidatesSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists candidates with status and savings', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'observed' }]), { status: 200 })])
    render(<CandidatesSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument()
    expect(screen.getByText(/observed/)).toBeInTheDocument()
  })

  it('optimizes a candidate: POSTs to the optimize endpoint and reloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    mockFetchSequence([
      () => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'observed' }]), { status: 200 }),
      (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: 'optimized' }), { status: 200 }) },
      () => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'optimized' }]), { status: 200 }),
    ])
    render(<CandidatesSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /optimize/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toContain('/api/env/dev/candidates/')
    expect(calls[0]!.url).toContain('/optimize')
    expect(calls[0]!.init!.method).toBe('POST')
  })

  it('hides Optimize for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ fingerprint: 'x', model: 'm', count: 1, estPredictedSavingsUsd: 0, status: 'observed' }]), { status: 200 })])
    render(<CandidatesSection envId="dev" canWrite={false} />)
    await screen.findByText('m')
    expect(screen.queryByRole('button', { name: /optimize/i })).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/CandidatesSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `config-manager-web/web/src/sections/CandidatesSection.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import { api } from '../api.js'
import type { CandidateRow } from '../types.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'

export function CandidatesSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.get<CandidateRow[]>(`/api/env/${envId}/candidates`).then(setRows).finally(() => setLoading(false))
  }, [envId])
  useEffect(reload, [reload])

  const optimize = async (fingerprint: string) => {
    setBusy(fingerprint)
    try {
      await api.post(`/api/env/${envId}/candidates/${encodeURIComponent(fingerprint)}/optimize`, {})
      setToast('Optimized'); setTimeout(() => setToast(null), 2000); reload()
    } finally { setBusy(null) }
  }

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>Candidates</h2>
      <p style={{ color: 'var(--text-muted)' }}>Prompts frequently run on costly models. Optimize one to generate a cheap-model template.</p>
      <Table headers={['Fingerprint', 'Model', 'Count', 'Est. savings', 'Status', canWrite ? 'Actions' : '']}>
        {rows.map(r => (
          <tr key={r.fingerprint}>
            <td title={r.fingerprint}>{r.fingerprint.slice(0, 24)}…</td>
            <td>{r.model}</td><td>{r.count}</td><td>{`$${r.estPredictedSavingsUsd.toFixed(4)}`}</td><td>{r.status}</td>
            <td>{canWrite && r.status !== 'optimized' && (
              <Button variant="ghost" disabled={busy === r.fingerprint} onClick={() => optimize(r.fingerprint)}>
                {busy === r.fingerprint ? 'Optimizing…' : 'Optimize'}
              </Button>
            )}</td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <p>No candidates yet.</p>}
      <Toast message={toast} />
    </div>
  )
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/CandidatesSection.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/sections/CandidatesSection.tsx config-manager-web/web/src/types.ts config-manager-web/web/test/CandidatesSection.test.tsx
git commit -m "feat(web-config): Candidates section (list + server-side optimize)"
```

---

## Task 7: Audit section

**Files:**
- Create: `config-manager-web/web/src/sections/AuditSection.tsx`
- Modify: `config-manager-web/web/src/types.ts` (add `AuditRow`)
- Test: `config-manager-web/web/test/AuditSection.test.tsx`

- [ ] **Step 1: Add `AuditRow` to `config-manager-web/web/src/types.ts`**

```ts
export interface AuditRow {
  timestamp: number; subject: string; environment: string; action: string; target: string
}
```

- [ ] **Step 2: Write the failing test**

`config-manager-web/web/test/AuditSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuditSection } from '../src/sections/AuditSection.js'

describe('AuditSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders recent audit records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { timestamp: 1749470000000, subject: 'alice', environment: 'prod', action: 'config:save', target: 'config' },
    ]), { status: 200 })))
    render(<AuditSection envId="dev" canWrite={false} />)
    expect(await screen.findByText('config:save')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('prod')).toBeInTheDocument()
  })

  it('fetches from the global audit endpoint', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return new Response('[]', { status: 200 }) }))
    render(<AuditSection envId="dev" canWrite={false} />)
    await screen.findByText(/no audit/i)
    expect(urls[0]).toContain('/api/audit')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/AuditSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `config-manager-web/web/src/sections/AuditSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { api } from '../api.js'
import type { AuditRow } from '../types.js'
import { Table } from '../components/Table.js'

export function AuditSection(_props: { envId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.get<AuditRow[]>('/api/audit').then(setRows).finally(() => setLoading(false)) }, [])

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>Audit</h2>
      <Table headers={['Time', 'User', 'Environment', 'Action', 'Target']}>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</td>
            <td>{r.subject}</td><td>{r.environment}</td><td>{r.action}</td><td>{r.target}</td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <p>No audit records yet.</p>}
    </div>
  )
}
```

Note: `AuditSection` ignores `envId`/`canWrite` (the audit log is global and read-only) but keeps the `{envId, canWrite}` prop shape so it slots into the AppShell section switch uniformly.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/AuditSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/sections/AuditSection.tsx config-manager-web/web/src/types.ts config-manager-web/web/test/AuditSection.test.tsx
git commit -m "feat(web-config): Audit section (recent admin actions)"
```

---

## Task 8: Wire Candidates + Audit into AppShell + Plan-4 verification

**Files:**
- Modify: `config-manager-web/web/src/app/AppShell.tsx`, `config-manager-web/web/test/AppShell.test.tsx`

- [ ] **Step 1: Extend the AppShell nav test**

In `config-manager-web/web/test/AppShell.test.tsx`, add `'Candidates'` and `'Audit'` to the expected nav-labels array. Confirm RED.

- [ ] **Step 2: Wire the sections into `config-manager-web/web/src/app/AppShell.tsx`**

Add imports:
```ts
import { CandidatesSection } from '../sections/CandidatesSection.js'
import { AuditSection } from '../sections/AuditSection.js'
```
Add to `SECTIONS` (after `byok`):
```ts
  { id: 'candidates', label: 'Candidates' },
  { id: 'audit', label: 'Audit' },
```
Add cases to the render switch:
```ts
              case 'candidates': return <CandidatesSection {...props} />
              case 'audit': return <AuditSection {...props} />
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run test/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 4: Full Plan-4 verification**

Run (from `config-manager-web/server/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all server tests pass (pricing-fetcher, pricing-routes, candidates-routes, audit-routes + all prior), typecheck clean, `dist/server.js` emitted; then `rm -rf dist`.

Run (from `config-manager-web/web/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all web tests pass (Candidates, Audit, Pricing fetch + all prior), typecheck clean, Vite build succeeds, `find src -name '*.js'` empty.

- [ ] **Step 5: Wire the real pricing fetcher + sidecar in `server.ts`**

In `config-manager-web/server/src/server.ts`, construct the real `pricingFetcher` and `sidecar` and pass them to `buildApp`:
```ts
import { LibraryPricingFetcher } from './pricing/pricing-fetcher.js'
import { HttpSidecarClient } from './optimization/sidecar-client.js'
import { liteLLMPricingSource, openRouterPricingSource } from 'finrouter'
// ...
  const pricingFetcher = new LibraryPricingFetcher({
    litellm: () => liteLLMPricingSource(),
    openrouter: () => openRouterPricingSource(),
  })
  const sidecar = cfg.gepaSidecarUrl !== undefined
    ? new HttpSidecarClient(cfg.gepaSidecarUrl, cfg.gepaSidecarToken)
    : undefined
```
Add `pricingFetcher,` and `...(sidecar !== undefined && { sidecar }),` to the `buildApp({...})` deps object. Run `npm run typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/app/AppShell.tsx config-manager-web/web/test/AppShell.test.tsx config-manager-web/server/src/server.ts
git commit -m "feat(web-config): wire Candidates + Audit nav; real pricing fetcher + sidecar in server"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan-4 portion):** server-side pricing fetch reusing `finrouter` sources, filtered to enabled providers (Task 2); auto-optimization candidates list + sidecar-driven optimize writing the optimized store + flipping status (Task 3); audit view route (Task 4); Pricing fetch dialog (Task 5); Candidates section (Task 6); Audit section (Task 7); nav + real wiring (Task 8). This completes config-manager feature parity; only e2e + Python-tool deletion (Plan 5) remain.
- **Injectable externals:** `PricingFetcher` and `SidecarClient` are interfaces injected via `AppDeps`; tests use fakes (no network). The real implementations (`LibraryPricingFetcher` over `finrouter` sources; `HttpSidecarClient` over `fetch`) are wired only in `server.ts` (Task 8 Step 5).
- **Fastify scope:** each new route plugin (`pricing-routes`, `candidates-routes`, `audit-routes`) declares its OWN `/api` auth `preHandler` — plugin hooks don't cross plugin boundaries (established in Plan 3). Each new route file's 401-unauthenticated test guards this.
- **Array-file handling:** candidates and optimized stores are JSON arrays; `JsonFileStore` defaults an absent file to `{}`, so reads go through a `readArray` normalizer (returns `[]` for a non-array), matching the rules-resource pattern from Plan 2. Writes use the store's version (read-then-write within the request) — acceptable for these admin-triggered, low-concurrency operations.
- **Security:** `pricing-fetch` and `candidates` GET require any role; `candidates optimize` requires admin (viewer 403); audit GET requires any authenticated role. The sidecar token and pricing source URLs stay server-side. Optimize is audited (`candidate:optimize`).
- **`buildTestApp` change:** adding the optional `{ withDir }` return must preserve all existing call sites (`const app = await buildTestApp()` keeps returning the app). Verify the whole server suite stays green after the helper change (Task 3).
- **No placeholders:** the candidates test's initial `lastTempDir`/`require` artifacts are explicitly corrected in Task 3 Steps 4–5 to use the `{ app, dir }` return and top-level `import`.
