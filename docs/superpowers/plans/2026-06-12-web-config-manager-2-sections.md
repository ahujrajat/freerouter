# Web Config Manager — Plan 2: Remaining Config Sections + Dialogs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remaining config-editing sections to the web manager — Rate Limit, Budgets (+ modal), Rules (+ modal, separate file), Pricing Overrides (+ modal), Optimization (config fields), and Env Vars (separate `.env` file) — reusing the Plan-1 patterns (`useConfig` hook, optimistic-lock routes, audit, Accenture theme).

**Architecture:** Sections that edit the main config file (Rate Limit, Budgets, Pricing Overrides, Optimization) reuse the existing `/api/env/:id/config` route + `useConfig` hook — each spreads the loaded config and overwrites only its slice (the Plan-1 key-preservation pattern). Rules and Env Vars live in separate files, so this plan adds two new server resources (`/api/env/:id/rules`, `/api/env/:id/env`) backed by `JsonFileStore` (rules) and a new `EnvFileStore` (dotenv text), and generalizes `useConfig` to address any resource. Two reusable UI primitives — `Modal` and `Table` — back the add/edit dialogs.

**Tech Stack:** Same as Plan 1 (Fastify/TS server, React/Vite/TS web, Vitest). Builds directly on Plan 1; do not restate Plan-1 tasks.

**Prerequisite:** Plan 1 is merged and green (server 30 tests, web 8 tests). Work from `config-manager-web/`.

This is **Plan 2 of the sequence**. BYOK (Plan 3), pricing-fetch + auto-optimization candidates panel + audit viewer (Plan 4), e2e + Python-tool deletion (Plan 5) are NOT in scope here.

---

## File Structure

```
config-manager-web/server/src/
  store/env-file-store.ts         # NEW: dotenv parse/serialize + optimistic lock
  validation.ts                   # MODIFY: add validateRulesPayload
  routes/config-routes.ts         # MODIFY: add /rules + /env GET/PUT
config-manager-web/server/test/
  env-file-store.test.ts          # NEW
  validation-rules.test.ts        # NEW
  config-routes.test.ts           # MODIFY: add rules + env route cases

config-manager-web/web/src/
  app/useConfig.ts                # MODIFY: accept a resource ('config'|'rules'|'env')
  components/Modal.tsx            # NEW
  components/Table.tsx            # NEW
  sections/RateLimitSection.tsx   # NEW
  sections/BudgetsSection.tsx     # NEW (+ BudgetModal in same file)
  sections/RulesSection.tsx       # NEW (+ RuleModal in same file)
  sections/PricingSection.tsx     # NEW (+ PricingModal in same file)
  sections/OptimizationSection.tsx# NEW
  sections/EnvVarsSection.tsx     # NEW
  app/AppShell.tsx                # MODIFY: register the 6 new sections in nav
config-manager-web/web/test/
  Modal.test.tsx, RateLimitSection.test.tsx, BudgetsSection.test.tsx,
  RulesSection.test.tsx, PricingSection.test.tsx, OptimizationSection.test.tsx,
  EnvVarsSection.test.tsx         # NEW
```

Run server commands from `config-manager-web/server/`, web commands from `config-manager-web/web/`.

---

## Task 1: EnvFileStore (dotenv parse/serialize + optimistic lock)

**Files:**
- Create: `config-manager-web/server/src/store/env-file-store.ts`
- Test: `config-manager-web/server/test/env-file-store.test.ts`

Mirrors the Python `config_io.load_env`/`save_env` semantics. Optimistic locking hashes the raw file text (same approach as `JsonFileStore`).

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/env-file-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvFileStore, StaleVersionError } from '../src/store/env-file-store.js'

describe('EnvFileStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-env-')); path = join(dir, '.env') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads {} for an absent file', () => {
    const a = new EnvFileStore(path).read()
    expect(a.data).toEqual({})
  })

  it('parses key=value pairs, skipping comments/blank lines and stripping quotes', () => {
    writeFileSync(path, '# comment\n\nA=1\nB="two words"\nC=plain\n', 'utf-8')
    expect(new EnvFileStore(path).read().data).toEqual({ A: '1', B: 'two words', C: 'plain' })
  })

  it('round-trips, quoting values that need it', () => {
    const store = new EnvFileStore(path)
    const { version } = store.read()
    store.write({ A: '1', B: 'two words', EMPTY: '' }, version)
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('A=1')
    expect(text).toContain('B="two words"')
    expect(text).toContain('EMPTY=""')
    expect(new EnvFileStore(path).read().data).toEqual({ A: '1', B: 'two words', EMPTY: '' })
  })

  it('rejects a stale write (optimistic lock)', () => {
    const store = new EnvFileStore(path)
    const stale = store.read().version
    store.write({ A: '1' }, stale)
    expect(() => store.write({ A: '2' }, stale)).toThrow(StaleVersionError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/env-file-store.test.ts`
Expected: FAIL — cannot find `../src/store/env-file-store.js`.

- [ ] **Step 3: Create `config-manager-web/server/src/store/env-file-store.ts`**

```ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VersionedDoc } from '../types.js'

export { StaleVersionError } from './config-store.js'
import { StaleVersionError } from './config-store.js'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1)
    }
    if (key !== '') out[key] = value
  }
  return out
}

function serializeEnv(env: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (key === '') continue
    const needsQuote = value === '' || /[ \t"'#$`\\]/.test(value)
    if (needsQuote) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      lines.push(`${key}="${escaped}"`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** A `.env` file as a string->string map, with raw-text content-hash optimistic locking. */
export class EnvFileStore {
  constructor(private readonly path: string) {}

  private text(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf-8') : ''
  }

  read(): VersionedDoc<Record<string, string>> {
    const raw = this.text()
    return { data: parseEnv(raw), version: sha256(raw) }
  }

  write(env: Record<string, string>, expectedVersion: string): VersionedDoc<Record<string, string>> {
    if (sha256(this.text()) !== expectedVersion) throw new StaleVersionError()
    const serialized = serializeEnv(env)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, serialized, 'utf-8')
    renameSync(tmp, this.path)
    return { data: env, version: sha256(serialized) }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/env-file-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/store/env-file-store.ts config-manager-web/server/test/env-file-store.test.ts
git commit -m "feat(web-config): env-file store (dotenv parse/serialize + optimistic lock)"
```

---

## Task 2: Rules validation + rules/env API routes

**Files:**
- Modify: `config-manager-web/server/src/validation.ts` (add `validateRulesPayload`)
- Modify: `config-manager-web/server/src/routes/config-routes.ts` (add 4 routes)
- Test: `config-manager-web/server/test/validation-rules.test.ts` (new), `config-manager-web/server/test/config-routes.test.ts` (extend)

Rules are stored as a JSON array of `Rule` objects (the format `FileRulesSource` reads). `.env` is the dotenv map. Both new resources enforce the same auth/RBAC/version/audit as `/config`.

- [ ] **Step 1: Write the failing rules-validation test**

`config-manager-web/server/test/validation-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateRulesPayload } from '../src/validation.js'

describe('validateRulesPayload', () => {
  it('accepts a valid rules array', () => {
    const r = validateRulesPayload([
      { id: 'pin-pro', match: { metadata: { tier: 'premium' } }, action: { type: 'pin', model: 'gpt-4o' } },
      { id: 'block-x', match: { userId: 'bad' }, action: { type: 'block', reason: 'no' } },
    ])
    expect(r.ok).toBe(true)
  })

  it('requires an array', () => {
    expect(validateRulesPayload({} as unknown).ok).toBe(false)
  })

  it('flags a rule missing id/match/action', () => {
    const r = validateRulesPayload([{ id: 'x' }])
    expect(r.ok).toBe(false)
    expect(r.messages.join(' ')).toMatch(/match|action/)
  })

  it('flags an unknown action type', () => {
    const r = validateRulesPayload([{ id: 'x', match: {}, action: { type: 'nope' } }])
    expect(r.ok).toBe(false)
    expect(r.messages.join(' ')).toMatch(/action.*type|type/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/validation-rules.test.ts`
Expected: FAIL — `validateRulesPayload` is not exported.

- [ ] **Step 3: Add `validateRulesPayload` to `config-manager-web/server/src/validation.ts`**

Append to the existing file (keep `validateConfigPayload` as-is):

```ts
const VALID_RULE_ACTIONS = new Set(['pin', 'strategy', 'block'])

/** Structural validation for a rules array (the JSON file FileRulesSource reads). */
export function validateRulesPayload(rules: unknown): ValidationOutcome {
  if (!Array.isArray(rules)) {
    return { ok: false, messages: ['rules must be a JSON array'] }
  }
  const messages: string[] = []
  rules.forEach((r, i) => {
    const rule = r as Record<string, unknown>
    const at = `rules[${i}]`
    if (typeof rule.id !== 'string' || rule.id === '') messages.push(`${at}.id must be a non-empty string`)
    if (typeof rule.match !== 'object' || rule.match === null) messages.push(`${at}.match must be an object`)
    const action = rule.action as Record<string, unknown> | undefined
    if (action === undefined || typeof action !== 'object') {
      messages.push(`${at}.action must be an object`)
    } else if (typeof action.type !== 'string' || !VALID_RULE_ACTIONS.has(action.type)) {
      messages.push(`${at}.action.type must be one of: ${[...VALID_RULE_ACTIONS].join(', ')}`)
    } else if (action.type === 'pin' && typeof action.model !== 'string') {
      messages.push(`${at}.action.model is required for a pin rule`)
    } else if (action.type === 'block' && typeof action.reason !== 'string') {
      messages.push(`${at}.action.reason is required for a block rule`)
    }
  })
  return { ok: messages.length === 0, messages }
}
```

- [ ] **Step 4: Write the failing route tests — extend `config-manager-web/server/test/config-routes.test.ts`**

Append these cases inside the existing `describe('config routes', ...)` block (the `login` helper and `buildTestApp` already exist in the file):

```ts
  it('reads and writes the rules resource', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toEqual([])
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/rules', headers: { cookie },
      payload: { data: [{ id: 'r1', match: {}, action: { type: 'block', reason: 'x' } }], version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data[0].id).toBe('r1')
    await app.close()
  })

  it('rejects invalid rules with 422', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/rules', headers: { cookie }, payload: { data: [{ id: 'x' }], version } })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('reads and writes the env resource', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/env', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toEqual({})
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/env', headers: { cookie },
      payload: { data: { GEMINI_API_KEY: 'abc' }, version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data.GEMINI_API_KEY).toBe('abc')
    await app.close()
  })

  it('forbids a viewer from writing rules (403)', async () => {
    const app = await buildTestApp({ claims: { sub: 'v', name: 'V', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/rules', headers: { cookie }, payload: { data: [], version } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
```

- [ ] **Step 5: Run to verify the new route tests fail**

Run: `npx vitest run test/config-routes.test.ts`
Expected: FAIL — the `/rules` and `/env` routes 404 (not registered yet).

- [ ] **Step 6: Add the routes in `config-manager-web/server/src/routes/config-routes.ts`**

Add the imports at the top (alongside the existing ones):

```ts
import { EnvFileStore } from '../store/env-file-store.js'
import { validateRulesPayload } from '../validation.js'
```

Then, inside `registerConfigRoutes`, add a small shared helper and the four routes. Place a generic versioned-write helper near the top of the function (after the `preHandler` hook), then the routes. This factoring keeps the three resources (config/rules/env) DRY:

```ts
  // Resolve env + role, or send the appropriate error. Returns the Environment on success.
  function resolveEnv(req: FastifyRequest, reply: FastifyReply, needWrite: boolean): import('../types.js').Environment | undefined {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) { reply.code(404).send({ error: 'unknown environment' }); return undefined }
    const role = roles.roleFor(user.groups, id)
    if (role === undefined) { reply.code(403).send({ error: 'forbidden' }); return undefined }
    if (needWrite && role !== 'admin') { reply.code(403).send({ error: 'forbidden' }); return undefined }
    return env
  }

  // ── rules resource (separate JSON file) ──
  app.get('/api/env/:id/rules', async (req, reply) => {
    const env = resolveEnv(req, reply, false)
    if (env === undefined) return
    return reply.send(new JsonFileStore(env.paths.rules).read())
  })

  app.put('/api/env/:id/rules', async (req, reply) => {
    const env = resolveEnv(req, reply, true)
    if (env === undefined) return
    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })
    const validation = validateRulesPayload(body.data)
    if (!validation.ok) return reply.code(422).send({ error: 'invalid rules', messages: validation.messages })
    const store = new JsonFileStore<object>(env.paths.rules)
    const before = store.read()
    try {
      const next = store.write(body.data as object, body.version)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'rules:save', target: 'rules', beforeHash: before.version, afterHash: next.version })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })

  // ── env-vars resource (.env file) ──
  app.get('/api/env/:id/env', async (req, reply) => {
    const env = resolveEnv(req, reply, false)
    if (env === undefined) return
    return reply.send(new EnvFileStore(env.paths.env).read())
  })

  app.put('/api/env/:id/env', async (req, reply) => {
    const env = resolveEnv(req, reply, true)
    if (env === undefined) return
    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)
        || !Object.values(body.data as Record<string, unknown>).every(v => typeof v === 'string')) {
      return reply.code(422).send({ error: 'invalid env', messages: ['env must be an object of string values'] })
    }
    const store = new EnvFileStore(env.paths.env)
    const before = store.read()
    try {
      const next = store.write(body.data as Record<string, string>, body.version)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'env:save', target: 'env', beforeHash: before.version, afterHash: next.version })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })
```

Note: `StaleVersionError` and `JsonFileStore` are already imported in this file from Plan 1; `FastifyRequest`/`FastifyReply` types are already imported. Do not duplicate imports.

- [ ] **Step 7: Run the server suite to verify all pass**

Run: `npx vitest run`
Run: `npm run typecheck`
Expected: all server tests pass (existing + new rules/env cases + validation-rules); typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add config-manager-web/server/src/validation.ts config-manager-web/server/src/routes/config-routes.ts config-manager-web/server/test/validation-rules.test.ts config-manager-web/server/test/config-routes.test.ts
git commit -m "feat(web-config): rules + env resources with validation, RBAC, optimistic lock, audit"
```

---

## Task 3: Generalize `useConfig` + add Modal and Table primitives

**Files:**
- Modify: `config-manager-web/web/src/app/useConfig.ts` (accept a resource)
- Create: `config-manager-web/web/src/components/Modal.tsx`, `config-manager-web/web/src/components/Table.tsx`
- Test: `config-manager-web/web/test/Modal.test.tsx`

- [ ] **Step 1: Generalize `useConfig` to address any resource**

In `config-manager-web/web/src/app/useConfig.ts`, change the hook signature to accept a resource path segment, defaulting to `'config'` so General/Providers keep working unchanged. Replace the function signature and the two URL string literals:

Change `export function useConfig<T extends object = Record<string, unknown>>(envId: string): UseConfig<T> {` to:
```ts
export function useConfig<T extends object = Record<string, unknown>>(
  envId: string,
  resource: 'config' | 'rules' | 'env' = 'config',
): UseConfig<T> {
```
Change the GET URL `` `/api/env/${envId}/config` `` to `` `/api/env/${envId}/${resource}` `` and the PUT URL `` `/api/env/${envId}/config` `` to `` `/api/env/${envId}/${resource}` ``. Update the `reload`/`save` `useCallback` dependency arrays to include `resource` (i.e. `[envId, resource]` and `[envId, resource, version]`).

- [ ] **Step 2: Verify General/Providers tests still pass (no behavior change for default resource)**

Run: `npx vitest run test/GeneralSection.test.tsx test/ProvidersSection.test.tsx`
Expected: PASS (5 tests) — the default `'config'` resource preserves the original URLs.

- [ ] **Step 3: Write the failing Modal test**

`config-manager-web/web/test/Modal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../src/components/Modal.js'

describe('Modal', () => {
  it('renders title + children when open and calls onClose on Cancel', async () => {
    const onClose = vi.fn()
    render(<Modal open title="Edit budget" onClose={onClose}><p>body</p></Modal>)
    expect(screen.getByRole('dialog')).toHaveTextContent('Edit budget')
    expect(screen.getByText('body')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false} title="x" onClose={() => {}}><p>hidden</p></Modal>)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/Modal.test.tsx`
Expected: FAIL — cannot find `../src/components/Modal.js`.

- [ ] **Step 5: Create `config-manager-web/web/src/components/Modal.tsx`**

```tsx
import type { ReactNode } from 'react'
import { Button } from './Button.js'

export function Modal({ open, title, onClose, children, footer }: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  if (!open) return null
  return (
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">{title}</div>
        <div className="modal__body">{children}</div>
        <div className="modal__footer">
          {footer}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Create `config-manager-web/web/src/components/Table.tsx`**

```tsx
import type { ReactNode } from 'react'

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <table className="table">
      <thead>
        <tr>{headers.map(h => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}
```

- [ ] **Step 7: Append theme rules for modal + table to `config-manager-web/web/src/theme.css`**

```css
.modal__backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: var(--surface); border-radius: var(--radius); width: min(560px, 92vw); max-height: 88vh; overflow: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.25); }
.modal__header { padding: 14px 16px; border-bottom: 2px solid var(--acc-purple); font-weight: 700; }
.modal__body { padding: 16px; }
.modal__footer { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }
.table { width: 100%; border-collapse: collapse; margin: 8px 0; }
.table th, .table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 14px; }
.table th { color: var(--text-muted); font-weight: 600; }
.row-actions { display: flex; gap: 6px; }
```

- [ ] **Step 8: Run to verify Modal passes + typecheck**

Run: `npx vitest run test/Modal.test.tsx`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add config-manager-web/web/src/app/useConfig.ts config-manager-web/web/src/components/Modal.tsx config-manager-web/web/src/components/Table.tsx config-manager-web/web/src/theme.css config-manager-web/web/test/Modal.test.tsx
git commit -m "feat(web-config): generalize useConfig to any resource; add Modal + Table primitives"
```

---

## Task 4: Rate Limit section

**Files:**
- Create: `config-manager-web/web/src/sections/RateLimitSection.tsx`
- Test: `config-manager-web/web/test/RateLimitSection.test.tsx`

Edits `config.rateLimit` (`{ requestsPerMinute, tokensPerMinute?, burstAllowance? }`) in the main config; preserves all other config keys.

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/RateLimitSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RateLimitSection } from '../src/sections/RateLimitSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('RateLimitSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads rateLimit and saves edits preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', rateLimit: { requestsPerMinute: 30 } }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<RateLimitSection envId="dev" canWrite={true} />)
    const rpm = await screen.findByLabelText('Requests per minute')
    expect((rpm as HTMLInputElement).value).toBe('30')
    await userEvent.clear(rpm)
    await userEvent.type(rpm, '60')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.rateLimit.requestsPerMinute).toBe(60)
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<RateLimitSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Requests per minute')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/RateLimitSection.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/RateLimitSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface RateLimit { requestsPerMinute?: number; tokensPerMinute?: number; burstAllowance?: number }
interface Cfg { rateLimit?: RateLimit; [k: string]: unknown }

const numOrUndef = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s))

export function RateLimitSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [rl, setRl] = useState<RateLimit>({})
  useEffect(() => { if (cfg.data !== null) setRl(cfg.data.rateLimit ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>
  const set = (k: keyof RateLimit, v: string) => setRl(prev => ({ ...prev, [k]: numOrUndef(v) }))
  const onSave = () => cfg.save({ ...(cfg.data ?? {}), rateLimit: rl })

  return (
    <div className="card">
      <h2>Rate Limit</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Field label="Requests per minute" htmlFor="rpm">
        <TextInput id="rpm" value={String(rl.requestsPerMinute ?? '')} disabled={!canWrite} onChange={(e) => set('requestsPerMinute', e.target.value)} />
      </Field>
      <Field label="Tokens per minute" htmlFor="tpm">
        <TextInput id="tpm" value={String(rl.tokensPerMinute ?? '')} disabled={!canWrite} onChange={(e) => set('tokensPerMinute', e.target.value)} />
      </Field>
      <Field label="Burst allowance (0–1)" htmlFor="burst">
        <TextInput id="burst" value={String(rl.burstAllowance ?? '')} disabled={!canWrite} onChange={(e) => set('burstAllowance', e.target.value)} />
      </Field>
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/RateLimitSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/RateLimitSection.tsx config-manager-web/web/test/RateLimitSection.test.tsx
git commit -m "feat(web-config): Rate Limit section"
```

---

## Task 5: Budgets section + Budget modal

**Files:**
- Create: `config-manager-web/web/src/sections/BudgetsSection.tsx`
- Test: `config-manager-web/web/test/BudgetsSection.test.tsx`

Edits `config.budgets` (`BudgetPolicy[]`). A table lists budgets; "Add budget" / "Edit" opens `BudgetModal`; "Delete" removes a row. Required fields per the validator: `id`, `maxSpendUsd`, `window` (one of hourly/daily/weekly/monthly/quarterly/total), `onLimitReached` (block/warn/downgrade/notify/throttle), `scope.type` (global/org/department/team/user). `fallbackModel` required when `onLimitReached === 'downgrade'`.

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/BudgetsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BudgetsSection } from '../src/sections/BudgetsSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}
const cfgRes = (budgets: unknown[], extra: object = {}) =>
  new Response(JSON.stringify({ data: { ...extra, budgets }, version: 'v1' }), { status: 200 })

describe('BudgetsSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing budgets', async () => {
    mockFetchSequence([() => cfgRes([{ id: 'org-monthly', scope: { type: 'org', orgId: 'o' }, window: 'monthly', maxSpendUsd: 5, onLimitReached: 'warn' }])])
    render(<BudgetsSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('org-monthly')).toBeInTheDocument()
  })

  it('adds a budget via the modal and saves, preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => cfgRes([], { defaultModel: 'keep' }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<BudgetsSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add budget/i }))
    await userEvent.type(screen.getByLabelText('ID'), 'team-daily')
    await userEvent.type(screen.getByLabelText('Max spend (USD)'), '0.5')
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'daily')
    await userEvent.selectOptions(screen.getByLabelText('On limit reached'), 'warn')
    await userEvent.selectOptions(screen.getByLabelText('Scope type'), 'global')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.budgets[0]).toMatchObject({ id: 'team-daily', window: 'daily', maxSpendUsd: 0.5, onLimitReached: 'warn', scope: { type: 'global' } })
  })

  it('hides Add for viewers', async () => {
    mockFetchSequence([() => cfgRes([])])
    render(<BudgetsSection envId="dev" canWrite={false} />)
    await screen.findByRole('button', { name: /save/i })
    expect(screen.queryByRole('button', { name: /add budget/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/BudgetsSection.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/BudgetsSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

const WINDOWS = ['hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'total']
const ACTIONS = ['block', 'warn', 'downgrade', 'notify', 'throttle']
const SCOPES = ['global', 'org', 'department', 'team', 'user']

interface Budget {
  id: string
  maxSpendUsd: number
  window: string
  onLimitReached: string
  scope: { type: string; orgId?: string; teamId?: string; departmentId?: string; userId?: string }
  fallbackModel?: string
}
interface Cfg { budgets?: Budget[]; [k: string]: unknown }

const blank = (): Budget => ({ id: '', maxSpendUsd: 0, window: 'monthly', onLimitReached: 'warn', scope: { type: 'global' } })

export function BudgetsSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [editing, setEditing] = useState<{ index: number; draft: Budget } | null>(null)
  useEffect(() => { if (cfg.data !== null) setBudgets(cfg.data.budgets ?? []) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const commit = (next: Budget[]) => { setBudgets(next); cfg.save({ ...(cfg.data ?? {}), budgets: next }) }
  const onModalConfirm = () => {
    if (editing === null) return
    const next = [...budgets]
    if (editing.index === -1) next.push(editing.draft)
    else next[editing.index] = editing.draft
    setBudgets(next)
    setEditing(null)
  }

  return (
    <div className="card">
      <h2>Budgets</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Table headers={['ID', 'Scope', 'Window', 'Max $', 'On limit', canWrite ? 'Actions' : '']}>
        {budgets.map((b, i) => (
          <tr key={i}>
            <td>{b.id}</td><td>{b.scope.type}</td><td>{b.window}</td><td>{b.maxSpendUsd}</td><td>{b.onLimitReached}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setEditing({ index: i, draft: b })}>Edit</Button>
                <Button variant="ghost" onClick={() => commit(budgets.filter((_, j) => j !== i))}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setEditing({ index: -1, draft: blank() })}>Add budget</Button>}{' '}
      <Button disabled={!canWrite} onClick={() => commit(budgets)}>Save</Button>
      <Toast message={cfg.toast} />

      <Modal open={editing !== null} title={editing?.index === -1 ? 'Add budget' : 'Edit budget'} onClose={() => setEditing(null)}
        footer={<Button onClick={onModalConfirm}>{editing?.index === -1 ? 'Add' : 'Update'}</Button>}>
        {editing !== null && (
          <BudgetForm draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />
        )}
      </Modal>
    </div>
  )
}

function BudgetForm({ draft, onChange }: { draft: Budget; onChange: (d: Budget) => void }) {
  const set = (patch: Partial<Budget>) => onChange({ ...draft, ...patch })
  return (
    <>
      <Field label="ID" htmlFor="b-id"><TextInput id="b-id" value={draft.id} onChange={(e) => set({ id: e.target.value })} /></Field>
      <Field label="Max spend (USD)" htmlFor="b-max"><TextInput id="b-max" value={String(draft.maxSpendUsd)} onChange={(e) => set({ maxSpendUsd: Number(e.target.value) })} /></Field>
      <Field label="Window" htmlFor="b-win">
        <select id="b-win" value={draft.window} onChange={(e) => set({ window: e.target.value })}>{WINDOWS.map(w => <option key={w} value={w}>{w}</option>)}</select>
      </Field>
      <Field label="On limit reached" htmlFor="b-act">
        <select id="b-act" value={draft.onLimitReached} onChange={(e) => set({ onLimitReached: e.target.value })}>{ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}</select>
      </Field>
      <Field label="Scope type" htmlFor="b-scope">
        <select id="b-scope" value={draft.scope.type} onChange={(e) => set({ scope: { ...draft.scope, type: e.target.value } })}>{SCOPES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      </Field>
      {draft.onLimitReached === 'downgrade' && (
        <Field label="Fallback model" htmlFor="b-fb"><TextInput id="b-fb" value={draft.fallbackModel ?? ''} onChange={(e) => set({ fallbackModel: e.target.value })} /></Field>
      )}
    </>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/BudgetsSection.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/BudgetsSection.tsx config-manager-web/web/test/BudgetsSection.test.tsx
git commit -m "feat(web-config): Budgets section + budget modal"
```

---

## Task 6: Rules section + Rule modal

**Files:**
- Create: `config-manager-web/web/src/sections/RulesSection.tsx`
- Test: `config-manager-web/web/test/RulesSection.test.tsx`

Edits the rules resource via `useConfig(envId, 'rules')` (a `Rule[]`). Rule shape: `{ id, priority?, match: RuleMatch, action: {type:'pin',model} | {type:'strategy',strategy,candidateModels?} | {type:'block',reason} }`. The modal edits id, a `modelPattern` match (simplest common match), and the action.

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/RulesSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RulesSection } from '../src/sections/RulesSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('RulesSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads rules from the rules resource and lists them', async () => {
    const urls: string[] = []
    mockFetchSequence([(u) => { urls.push(u); return new Response(JSON.stringify({ data: [{ id: 'pin1', match: {}, action: { type: 'pin', model: 'gpt-4o' } }], version: 'v1' }), { status: 200 }) }])
    render(<RulesSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('pin1')).toBeInTheDocument()
    expect(urls[0]).toContain('/api/env/dev/rules')
  })

  it('adds a block rule via the modal and saves', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: [], version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: [], version: 'v2' }), { status: 200 }) },
    ])
    render(<RulesSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add rule/i }))
    await userEvent.type(screen.getByLabelText('ID'), 'block-bad')
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'block')
    await userEvent.type(screen.getByLabelText(/reason/i), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data[0]).toMatchObject({ id: 'block-bad', action: { type: 'block', reason: 'nope' } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/RulesSection.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/RulesSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

type Action =
  | { type: 'pin'; model: string }
  | { type: 'strategy'; strategy: string; candidateModels?: string[] }
  | { type: 'block'; reason: string }
interface Rule { id: string; priority?: number; match: { modelPattern?: string }; action: Action }

const blank = (): Rule => ({ id: '', match: {}, action: { type: 'pin', model: '' } })
const actionSummary = (a: Action): string =>
  a.type === 'pin' ? `pin → ${a.model}` : a.type === 'block' ? `block (${a.reason})` : `strategy ${a.strategy}`

export function RulesSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const rules = useConfig<Rule[]>(envId, 'rules')
  const [list, setList] = useState<Rule[]>([])
  const [editing, setEditing] = useState<{ index: number; draft: Rule } | null>(null)
  useEffect(() => { if (rules.data !== null) setList(rules.data) }, [rules.data])

  if (rules.loading) return <div className="card">Loading…</div>

  const commit = (next: Rule[]) => { setList(next); rules.save(next) }
  const onConfirm = () => {
    if (editing === null) return
    const next = [...list]
    if (editing.index === -1) next.push(editing.draft); else next[editing.index] = editing.draft
    setList(next); setEditing(null)
  }

  return (
    <div className="card">
      <h2>Rules</h2>
      {rules.conflict && <ConflictBanner onReload={rules.reload} />}
      {rules.errors.length > 0 && <div className="banner banner--conflict" role="alert">{rules.errors.join('; ')}</div>}
      <Table headers={['ID', 'Model pattern', 'Action', canWrite ? 'Actions' : '']}>
        {list.map((r, i) => (
          <tr key={i}>
            <td>{r.id}</td><td>{r.match.modelPattern ?? '*'}</td><td>{actionSummary(r.action)}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setEditing({ index: i, draft: r })}>Edit</Button>
                <Button variant="ghost" onClick={() => commit(list.filter((_, j) => j !== i))}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setEditing({ index: -1, draft: blank() })}>Add rule</Button>}{' '}
      <Button disabled={!canWrite} onClick={() => commit(list)}>Save</Button>
      <Toast message={rules.toast} />

      <Modal open={editing !== null} title={editing?.index === -1 ? 'Add rule' : 'Edit rule'} onClose={() => setEditing(null)}
        footer={<Button onClick={onConfirm}>{editing?.index === -1 ? 'Add' : 'Update'}</Button>}>
        {editing !== null && <RuleForm draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />}
      </Modal>
    </div>
  )
}

function RuleForm({ draft, onChange }: { draft: Rule; onChange: (r: Rule) => void }) {
  const setAction = (type: Action['type']) => {
    const action: Action = type === 'pin' ? { type: 'pin', model: '' } : type === 'block' ? { type: 'block', reason: '' } : { type: 'strategy', strategy: 'cheapest' }
    onChange({ ...draft, action })
  }
  return (
    <>
      <Field label="ID" htmlFor="r-id"><TextInput id="r-id" value={draft.id} onChange={(e) => onChange({ ...draft, id: e.target.value })} /></Field>
      <Field label="Model pattern (glob, optional)" htmlFor="r-mp">
        <TextInput id="r-mp" value={draft.match.modelPattern ?? ''} onChange={(e) => onChange({ ...draft, match: { ...draft.match, modelPattern: e.target.value || undefined } })} />
      </Field>
      <Field label="Action" htmlFor="r-act">
        <select id="r-act" value={draft.action.type} onChange={(e) => setAction(e.target.value as Action['type'])}>
          <option value="pin">pin</option><option value="strategy">strategy</option><option value="block">block</option>
        </select>
      </Field>
      {draft.action.type === 'pin' && (
        <Field label="Model to pin" htmlFor="r-model"><TextInput id="r-model" value={draft.action.model} onChange={(e) => onChange({ ...draft, action: { type: 'pin', model: e.target.value } })} /></Field>
      )}
      {draft.action.type === 'block' && (
        <Field label="Block reason" htmlFor="r-reason"><TextInput id="r-reason" value={draft.action.reason} onChange={(e) => onChange({ ...draft, action: { type: 'block', reason: e.target.value } })} /></Field>
      )}
      {draft.action.type === 'strategy' && (
        <Field label="Strategy" htmlFor="r-strat">
          <select id="r-strat" value={draft.action.strategy} onChange={(e) => onChange({ ...draft, action: { type: 'strategy', strategy: e.target.value } })}>
            <option value="cheapest">cheapest</option><option value="balanced">balanced</option><option value="performance">performance</option>
          </select>
        </Field>
      )}
    </>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/RulesSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/RulesSection.tsx config-manager-web/web/test/RulesSection.test.tsx
git commit -m "feat(web-config): Rules section + rule modal (separate rules file)"
```

---

## Task 7: Pricing Overrides section + Pricing modal

**Files:**
- Create: `config-manager-web/web/src/sections/PricingSection.tsx`
- Test: `config-manager-web/web/test/PricingSection.test.tsx`

Edits `config.pricingOverrides` — a flat `Record<modelId, { input: number; output: number; cachedInput?: number }>`. (Pricing FETCH from LiteLLM/OpenRouter is Plan 4; this is manual entry.) Table keyed by model id; modal adds/edits one model's rates.

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/PricingSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PricingSection } from '../src/sections/PricingSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('PricingSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing overrides', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: { pricingOverrides: { 'gpt-4o': { input: 2.5, output: 10 } } }, version: 'v1' }), { status: 200 })])
    render(<PricingSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument()
  })

  it('adds an override via modal and saves preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', pricingOverrides: {} }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<PricingSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add override/i }))
    await userEvent.type(screen.getByLabelText('Model ID'), 'gpt-4o')
    await userEvent.type(screen.getByLabelText('Input $/1M'), '2.5')
    await userEvent.type(screen.getByLabelText('Output $/1M'), '10')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.pricingOverrides['gpt-4o']).toMatchObject({ input: 2.5, output: 10 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/PricingSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/PricingSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface Rate { input: number; output: number; cachedInput?: number }
type Overrides = Record<string, Rate>
interface Cfg { pricingOverrides?: Overrides; [k: string]: unknown }

export function PricingSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [over, setOver] = useState<Overrides>({})
  const [draft, setDraft] = useState<{ model: string; rate: Rate } | null>(null)
  useEffect(() => { if (cfg.data !== null) setOver(cfg.data.pricingOverrides ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const commit = (next: Overrides) => { setOver(next); cfg.save({ ...(cfg.data ?? {}), pricingOverrides: next }) }
  const onConfirm = () => {
    if (draft === null || draft.model.trim() === '') return
    setOver(prev => ({ ...prev, [draft.model]: draft.rate })); setDraft(null)
  }

  return (
    <div className="card">
      <h2>Pricing Overrides</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Table headers={['Model', 'Input $/1M', 'Output $/1M', 'Cached $/1M', canWrite ? 'Actions' : '']}>
        {Object.entries(over).map(([model, r]) => (
          <tr key={model}>
            <td>{model}</td><td>{r.input}</td><td>{r.output}</td><td>{r.cachedInput ?? '—'}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setDraft({ model, rate: r })}>Edit</Button>
                <Button variant="ghost" onClick={() => { const n = { ...over }; delete n[model]; commit(n) }}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setDraft({ model: '', rate: { input: 0, output: 0 } })}>Add override</Button>}{' '}
      <Button disabled={!canWrite} onClick={() => commit(over)}>Save</Button>
      <Toast message={cfg.toast} />

      <Modal open={draft !== null} title="Pricing override" onClose={() => setDraft(null)}
        footer={<Button onClick={onConfirm}>Add</Button>}>
        {draft !== null && (
          <>
            <Field label="Model ID" htmlFor="p-model"><TextInput id="p-model" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></Field>
            <Field label="Input $/1M" htmlFor="p-in"><TextInput id="p-in" value={String(draft.rate.input)} onChange={(e) => setDraft({ ...draft, rate: { ...draft.rate, input: Number(e.target.value) } })} /></Field>
            <Field label="Output $/1M" htmlFor="p-out"><TextInput id="p-out" value={String(draft.rate.output)} onChange={(e) => setDraft({ ...draft, rate: { ...draft.rate, output: Number(e.target.value) } })} /></Field>
            <Field label="Cached input $/1M (optional)" htmlFor="p-cache"><TextInput id="p-cache" value={String(draft.rate.cachedInput ?? '')} onChange={(e) => setDraft({ ...draft, rate: { ...draft.rate, cachedInput: e.target.value === '' ? undefined : Number(e.target.value) } })} /></Field>
          </>
        )}
      </Modal>
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/PricingSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/PricingSection.tsx config-manager-web/web/test/PricingSection.test.tsx
git commit -m "feat(web-config): Pricing Overrides section + modal (manual entry)"
```

---

## Task 8: Optimization section (config fields)

**Files:**
- Create: `config-manager-web/web/src/sections/OptimizationSection.tsx`
- Test: `config-manager-web/web/test/OptimizationSection.test.tsx`

Edits the path/threshold metadata for `telemetryExport`, `promptOptimization`, and `autoOptimization` in the main config — mirroring the Python Optimization tab's editable fields (the auto-optimization **candidates panel** itself is Plan 4). Keep it to the file-loadable scalar fields; preserve all other keys.

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/OptimizationSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OptimizationSection } from '../src/sections/OptimizationSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('OptimizationSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('toggles autoOptimization.enabled and saves preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', autoOptimization: { enabled: false, targetModel: 'm' } }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<OptimizationSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByLabelText('Enable auto-optimization'))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.autoOptimization.enabled).toBe(true)
    expect(body.data.autoOptimization.targetModel).toBe('m')   // existing sub-key preserved
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<OptimizationSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Enable auto-optimization')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/OptimizationSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/OptimizationSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Toggle } from '../components/Toggle.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface Cfg {
  telemetryExport?: { intervalMs?: number; maxBufferSize?: number }
  promptOptimization?: { enabled?: boolean; targetModel?: string; fallbackModel?: string }
  autoOptimization?: { enabled?: boolean; targetModel?: string; candidatesPath?: string; optimizedStorePath?: string }
  [k: string]: unknown
}

export function OptimizationSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [form, setForm] = useState<Cfg>({})
  useEffect(() => { if (cfg.data !== null) setForm(cfg.data) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const po = form.promptOptimization ?? {}
  const ao = form.autoOptimization ?? {}
  const setPO = (patch: object) => setForm(prev => ({ ...prev, promptOptimization: { ...prev.promptOptimization, ...patch } }))
  const setAO = (patch: object) => setForm(prev => ({ ...prev, autoOptimization: { ...prev.autoOptimization, ...patch } }))

  return (
    <div className="card">
      <h2>Optimization</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}

      <h3>Per-request prompt optimization (GEPA)</h3>
      <div className="field"><Toggle id="po-en" label="Enable prompt optimization" checked={po.enabled === true} onChange={(v) => setPO({ enabled: v })} /></div>
      <Field label="Target (cheap) model" htmlFor="po-target"><TextInput id="po-target" value={String(po.targetModel ?? '')} disabled={!canWrite} onChange={(e) => setPO({ targetModel: e.target.value || undefined })} /></Field>
      <Field label="Fallback (capable) model" htmlFor="po-fb"><TextInput id="po-fb" value={String(po.fallbackModel ?? '')} disabled={!canWrite} onChange={(e) => setPO({ fallbackModel: e.target.value || undefined })} /></Field>

      <h3>Auto-optimization</h3>
      <div className="field"><Toggle id="ao-en" label="Enable auto-optimization" checked={ao.enabled === true} onChange={(v) => setAO({ enabled: v })} /></div>
      <Field label="Target (cheap) model" htmlFor="ao-target"><TextInput id="ao-target" value={String(ao.targetModel ?? '')} disabled={!canWrite} onChange={(e) => setAO({ targetModel: e.target.value || undefined })} /></Field>
      <Field label="Candidates file path" htmlFor="ao-cand"><TextInput id="ao-cand" value={String(ao.candidatesPath ?? '')} disabled={!canWrite} onChange={(e) => setAO({ candidatesPath: e.target.value || undefined })} /></Field>
      <Field label="Optimized store path" htmlFor="ao-opt"><TextInput id="ao-opt" value={String(ao.optimizedStorePath ?? '')} disabled={!canWrite} onChange={(e) => setAO({ optimizedStorePath: e.target.value || undefined })} /></Field>

      <Button disabled={!canWrite} onClick={() => cfg.save(form)}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
```

Note: `form` is seeded from the entire loaded config and only the optimization sub-objects are patched, so every other top-level key is preserved on save (same pattern as GeneralSection). The `Toggle` itself has no disabled prop in the Plan-1 component; viewers are gated by the disabled Save button (writes can't be submitted). If you want toggles visually disabled for viewers too, that's a later polish — do not change the shared Toggle component here.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/OptimizationSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/OptimizationSection.tsx config-manager-web/web/test/OptimizationSection.test.tsx
git commit -m "feat(web-config): Optimization section (prompt + auto optimization config fields)"
```

---

## Task 9: Env Vars section

**Files:**
- Create: `config-manager-web/web/src/sections/EnvVarsSection.tsx`
- Test: `config-manager-web/web/test/EnvVarsSection.test.tsx`

Edits the `.env` resource via `useConfig(envId, 'env')` (a `Record<string,string>`). Key/value rows, add/delete. Values are shown in plaintext here (this section is general env vars; provider SECRETS are handled by the BYOK section in Plan 3, never shown).

- [ ] **Step 1: Write the failing test**

`config-manager-web/web/test/EnvVarsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EnvVarsSection } from '../src/sections/EnvVarsSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('EnvVarsSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads env vars from the env resource and saves an added pair', async () => {
    const calls: RequestInit[] = []
    const urls: string[] = []
    mockFetchSequence([
      (u) => { urls.push(u); return new Response(JSON.stringify({ data: { EXISTING: 'x' }, version: 'v1' }), { status: 200 }) },
      (u, i) => { urls.push(u); calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<EnvVarsSection envId="dev" canWrite={true} />)
    expect((await screen.findByDisplayValue('EXISTING')).tagName).toBe('INPUT')
    await userEvent.click(screen.getByRole('button', { name: /add variable/i }))
    const keyInputs = screen.getAllByLabelText(/var name/i)
    await userEvent.type(keyInputs[keyInputs.length - 1]!, 'NEW_KEY')
    const valInputs = screen.getAllByLabelText(/var value/i)
    await userEvent.type(valInputs[valInputs.length - 1]!, 'newval')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(urls[0]).toContain('/api/env/dev/env')
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data).toMatchObject({ EXISTING: 'x', NEW_KEY: 'newval' })
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<EnvVarsSection envId="dev" canWrite={false} />)
    await screen.findByRole('button', { name: /save/i })
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/EnvVarsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Create `config-manager-web/web/src/sections/EnvVarsSection.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

type Pair = { key: string; value: string }

export function EnvVarsSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const env = useConfig<Record<string, string>>(envId, 'env')
  const [pairs, setPairs] = useState<Pair[]>([])
  useEffect(() => { if (env.data !== null) setPairs(Object.entries(env.data).map(([key, value]) => ({ key, value }))) }, [env.data])

  if (env.loading) return <div className="card">Loading…</div>

  const onSave = () => {
    const obj: Record<string, string> = {}
    for (const p of pairs) if (p.key.trim() !== '') obj[p.key] = p.value
    env.save(obj)
  }

  return (
    <div className="card">
      <h2>Env Vars</h2>
      {env.conflict && <ConflictBanner onReload={env.reload} />}
      {env.errors.length > 0 && <div className="banner banner--conflict" role="alert">{env.errors.join('; ')}</div>}
      {pairs.map((p, i) => (
        <div key={i} className="field" style={{ display: 'flex', gap: 8 }}>
          <input aria-label={`var name ${i}`} value={p.key} disabled={!canWrite}
            onChange={(e) => setPairs(prev => prev.map((q, j) => j === i ? { ...q, key: e.target.value } : q))} />
          <input aria-label={`var value ${i}`} value={p.value} disabled={!canWrite}
            onChange={(e) => setPairs(prev => prev.map((q, j) => j === i ? { ...q, value: e.target.value } : q))} />
          {canWrite && <Button variant="ghost" onClick={() => setPairs(prev => prev.filter((_, j) => j !== i))}>Remove</Button>}
        </div>
      ))}
      {canWrite && <Button onClick={() => setPairs(prev => [...prev, { key: '', value: '' }])}>Add variable</Button>}{' '}
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={env.toast} />
    </div>
  )
}
```

Note: the test's `getByLabelText(/var name/i)` matches the `aria-label="var name {i}"` inputs; the newest row is the last element. `getByDisplayValue('EXISTING')` finds the pre-loaded key input.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/EnvVarsSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/web/src/sections/EnvVarsSection.tsx config-manager-web/web/test/EnvVarsSection.test.tsx
git commit -m "feat(web-config): Env Vars section"
```

---

## Task 10: Wire sections into AppShell + Plan-2 verification

**Files:**
- Modify: `config-manager-web/web/src/app/AppShell.tsx`
- Test: `config-manager-web/web/test/AppShell.test.tsx` (new)

- [ ] **Step 1: Write the failing nav test**

`config-manager-web/web/test/AppShell.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppShell } from '../src/app/AppShell.js'

beforeEach(() => vi.restoreAllMocks())

it('shows all section nav items and switches to Rate Limit', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/env/dev/')) return new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })
    if (url.endsWith('/api/env')) return new Response(JSON.stringify([{ id: 'dev', label: 'Development', role: 'admin' }]), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
  render(<AppShell me={{ subject: 'u', name: 'Ada', groups: ['fr-admins'] }} />)
  for (const label of ['General', 'Providers', 'Rate Limit', 'Budgets', 'Rules', 'Pricing Overrides', 'Optimization', 'Env Vars']) {
    expect(await screen.findByRole('link', { name: label })).toBeInTheDocument()
  }
  await userEvent.click(screen.getByRole('link', { name: 'Rate Limit' }))
  expect(await screen.findByRole('heading', { name: 'Rate Limit' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/AppShell.test.tsx`
Expected: FAIL — only General/Providers nav items exist.

- [ ] **Step 3: Update `config-manager-web/web/src/app/AppShell.tsx`**

Add imports for the six new sections, extend the `SECTIONS` list and the `SectionId` union, and replace the section-render switch. Replace the existing `SECTIONS` constant and the render expression:

```tsx
import { GeneralSection } from '../sections/GeneralSection.js'
import { ProvidersSection } from '../sections/ProvidersSection.js'
import { RateLimitSection } from '../sections/RateLimitSection.js'
import { BudgetsSection } from '../sections/BudgetsSection.js'
import { RulesSection } from '../sections/RulesSection.js'
import { PricingSection } from '../sections/PricingSection.js'
import { OptimizationSection } from '../sections/OptimizationSection.js'
import { EnvVarsSection } from '../sections/EnvVarsSection.js'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'ratelimit', label: 'Rate Limit' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'rules', label: 'Rules' },
  { id: 'pricing', label: 'Pricing Overrides' },
  { id: 'optimization', label: 'Optimization' },
  { id: 'envvars', label: 'Env Vars' },
] as const
type SectionId = typeof SECTIONS[number]['id']
```

Replace the `<main>` render block's section selection with:

```tsx
        <main>
          {envId === '' ? <div className="card">No environments available to you.</div> : (() => {
            const props = { envId, canWrite }
            switch (section) {
              case 'general': return <GeneralSection {...props} />
              case 'providers': return <ProvidersSection {...props} />
              case 'ratelimit': return <RateLimitSection {...props} />
              case 'budgets': return <BudgetsSection {...props} />
              case 'rules': return <RulesSection {...props} />
              case 'pricing': return <PricingSection {...props} />
              case 'optimization': return <OptimizationSection {...props} />
              case 'envvars': return <EnvVarsSection {...props} />
            }
          })()}
        </main>
```

Keep the `useState<SectionId>('general')` initialization and the nav `.map` over `SECTIONS` unchanged (they already render a link per section with `className={s.id === section ? 'active' : ''}`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full Plan-2 verification**

Run (from `config-manager-web/web/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all web tests pass (Plan-1 + all Plan-2 sections + Modal + AppShell), typecheck clean, Vite build succeeds.

Run (from `config-manager-web/server/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all server tests pass (Plan-1 + env-file-store + validation-rules + rules/env routes), typecheck clean, `dist/server.js` emitted.

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/app/AppShell.tsx config-manager-web/web/test/AppShell.test.tsx
git commit -m "feat(web-config): wire all config sections into AppShell nav"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan-2 portion):** Rate Limit (Task 4), Budgets + modal (Task 5), Rules + modal via separate file (Tasks 2+6), Pricing Overrides + modal (Task 7), Optimization config fields (Task 8), Env Vars via separate `.env` file (Tasks 1+2+9), all wired into nav (Task 10). BYOK, pricing-fetch, candidates panel, audit viewer, e2e, and Python-tool deletion remain deferred to Plans 3–5.
- **Type/contract consistency:** every main-config section reuses `useConfig<T>(envId)` (default `'config'` resource) and saves via `{ ...cfg.data, <slice> }` to preserve unrendered keys — the Plan-1 data-loss-prevention pattern, asserted by each section's "preserves other keys" test. Rules/Env use `useConfig<T>(envId, 'rules'|'env')` against the new routes, which apply the same version/RBAC/audit/409/422 contract as `/config`. `VersionedDoc {data,version}` is identical across all three resources.
- **No placeholders:** every step has complete code; the `useConfig` change is a precise signature + URL edit that leaves General/Providers behavior identical (verified in Task 3 Step 2).
- **Server reuse:** `EnvFileStore` re-exports `StaleVersionError` from `config-store.ts` so the route handlers' `instanceof StaleVersionError` check works uniformly for both stores.
- **Validation:** rules get a dedicated structural validator (`validateRulesPayload`); env values are constrained to string maps at the route. Main-config sections continue to use `validateConfigPayload` (Plan 1 / Task 0).
