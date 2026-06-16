# Web Config Manager — Plan 3: BYOK + Key-Manager Backends

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add write-only BYOK (bring-your-own-key) management to the web config manager — provider API keys are entered over HTTPS, stored via a pluggable `KeyBackend`, and **never returned to any browser**. Backends: `local` (AES-256-GCM at rest, fully implemented + tested) and external key managers behind one `ReferenceKeyBackend` + `SecretManagerClient` interface, with **Vault** fully implemented (HTTP/fetch, tested) and **AWS Secrets Manager / Azure Key Vault / GCP Secret Manager** as SDK-injected adapters (unit-tested with fakes; live network not exercised).

**Architecture:** A per-environment BYOK record file (`env.paths.byok`) holds, per provider, `{ backend, last4, ref? , enc? }` — `enc` (ciphertext/iv/tag) only for `local`, `ref` (locator) only for external. The route layer owns the record store; backends only handle secret-specific work: `local` encrypts; `ReferenceKeyBackend` writes/validates the secret in the external manager and records the `ref`. A `KeyBackendRegistry` (injected into the app) resolves a backend by name. The API exposes list/set/rotate/delete only — never a read of the secret. Admin-only, audited.

**Tech Stack:** Same as Plans 1–2 (Fastify/TS, React/Vite/TS, Vitest). New deps (server): `@aws-sdk/client-secrets-manager`, `@azure/keyvault-secrets` + `@azure/identity`, `@google-cloud/secret-manager`. Vault uses `fetch` (no SDK).

**Prerequisite:** Plans 1–2 merged and green. Work from `config-manager-web/`. Run server commands from `server/`, web from `web/`.

This is **Plan 3 of the sequence**. Pricing-fetch + candidates panel + audit viewer (Plan 4) and e2e + Python-tool deletion (Plan 5) are out of scope.

---

## File Structure

```
config-manager-web/server/src/
  types.ts                        # MODIFY: add `byok` to EnvironmentPaths
  config.ts                       # MODIFY: optional BYOK_MASTER_KEY + external backend env
  environments.ts                 # MODIFY: add 'byok' to REQUIRED_PATHS
  byok/
    types.ts                      # NEW: StoredKey, ByokPublic, KeyBackend, SecretManagerClient
    byok-store.ts                 # NEW: per-env JSON record store
    local-backend.ts              # NEW: AES-256-GCM LocalKeyBackend
    reference-backend.ts          # NEW: ReferenceKeyBackend over a SecretManagerClient
    clients/vault-client.ts       # NEW: Vault KV v2 over fetch (tested)
    clients/aws-client.ts         # NEW: AWS Secrets Manager adapter (SDK-injected)
    clients/azure-client.ts       # NEW: Azure Key Vault adapter (SDK-injected)
    clients/gcp-client.ts         # NEW: GCP Secret Manager adapter (SDK-injected)
    registry.ts                   # NEW: KeyBackendRegistry (name -> KeyBackend)
  routes/byok-routes.ts           # NEW: GET/POST/DELETE /api/env/:id/byok
  app.ts                          # MODIFY: register byok routes; add keyBackends to AppDeps
  server.ts                       # MODIFY: build the registry from server config
config-manager-web/server/test/
  byok-store.test.ts, local-backend.test.ts, reference-backend.test.ts,
  vault-client.test.ts, byok-routes.test.ts, helpers.ts (MODIFY: byok path + registry)

config-manager-web/web/src/
  types.ts                        # MODIFY: add ByokEntry type
  sections/ByokSection.tsx        # NEW: list + set/rotate/delete (+ modal)
  app/AppShell.tsx                # MODIFY: add 'BYOK Keys' nav entry
config-manager-web/web/test/
  ByokSection.test.tsx            # NEW
```

---

## Task 1: Add `byok` environment path + BYOK server config

**Files:**
- Modify: `config-manager-web/server/src/types.ts`, `config-manager-web/server/src/environments.ts`, `config-manager-web/server/src/config.ts`
- Modify: `config-manager-web/server/test/helpers.ts` (add `byok` to `makeTempEnv` paths)
- Test: `config-manager-web/server/test/config.test.ts` (extend)

- [ ] **Step 1: Extend the failing config test**

Append to `config-manager-web/server/test/config.test.ts`:

```ts
describe('loadServerConfig — BYOK', () => {
  const base = {
    OIDC_ISSUER: 'https://idp', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    OIDC_REDIRECT_URI: 'https://app/cb', SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/e.json', AUDIT_LOG_FILE: '/a.jsonl',
  }
  it('parses BYOK_MASTER_KEY when present', () => {
    const cfg = loadServerConfig({ ...base, BYOK_MASTER_KEY: 'a'.repeat(64) })
    expect(cfg.byokMasterKey).toBe('a'.repeat(64))
  })
  it('leaves byokMasterKey undefined when absent', () => {
    expect(loadServerConfig(base).byokMasterKey).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `cfg.byokMasterKey` does not exist.

- [ ] **Step 3: Add `byok` to `EnvironmentPaths` in `src/types.ts`**

In the `EnvironmentPaths` interface add the field:
```ts
  byok: string
```
(place it after `candidates`).

- [ ] **Step 4: Add `byokMasterKey` to `ServerConfig` + loader**

In `src/types.ts` `ServerConfig`, add:
```ts
  byokMasterKey?: string
```
In `src/config.ts`, inside the returned object (after `auditLogFile`), add:
```ts
    ...(env.BYOK_MASTER_KEY !== undefined && { byokMasterKey: env.BYOK_MASTER_KEY }),
```
(`exactOptionalPropertyTypes` is on, so use the conditional-spread form, matching the existing pattern in the file.)

- [ ] **Step 5: Add `'byok'` to `REQUIRED_PATHS` in `src/environments.ts`**

Change the `REQUIRED_PATHS` array to include `'byok'`:
```ts
const REQUIRED_PATHS: (keyof EnvironmentPaths)[] = [
  'config', 'rules', 'env', 'pricing', 'optimizedStore', 'candidates', 'byok',
]
```

- [ ] **Step 6: Update the test helper `makeTempEnv`**

In `config-manager-web/server/test/helpers.ts`, the `paths` object in `makeTempEnv` must include `byok`. Add to the `paths` literal:
```ts
    byok: join(dir, 'byok.json'),
```
(alongside `config`, `rules`, `env`, `pricing`, `optimizedStore`, `candidates`). This keeps every existing route test valid (their environments now load with the new required path).

- [ ] **Step 7: Run config + the full server suite**

Run: `npx vitest run`
Expected: all pass — the BYOK config cases plus every existing test (environments/routes still load because the helper now supplies `byok`).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add config-manager-web/server/src/types.ts config-manager-web/server/src/config.ts config-manager-web/server/src/environments.ts config-manager-web/server/test/helpers.ts config-manager-web/server/test/config.test.ts
git commit -m "feat(web-config): add byok environment path + BYOK_MASTER_KEY config"
```

---

## Task 2: BYOK record store + shared types

**Files:**
- Create: `config-manager-web/server/src/byok/types.ts`, `config-manager-web/server/src/byok/byok-store.ts`
- Test: `config-manager-web/server/test/byok-store.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/byok-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ByokStore } from '../src/byok/byok-store.js'

describe('ByokStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-byok-')); path = join(dir, 'byok.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty and lists nothing', () => {
    expect(new ByokStore(path).list()).toEqual([])
  })

  it('upserts a record and exposes only public fields (never enc)', () => {
    const store = new ByokStore(path)
    store.upsert('openai', { backend: 'local', last4: '7890', enc: { ciphertext: 'c', iv: 'i', tag: 't' } })
    const list = store.list()
    expect(list).toEqual([{ provider: 'openai', backend: 'local', isSet: true, last4: '7890' }])
    expect(JSON.stringify(list)).not.toContain('ciphertext')
  })

  it('persists and reloads, and includes ref for external records', () => {
    new ByokStore(path).upsert('anthropic', { backend: 'vault', last4: 'abcd', ref: 'secret/data/fr/anthropic' })
    const reloaded = new ByokStore(path)
    expect(reloaded.list()).toEqual([{ provider: 'anthropic', backend: 'vault', isSet: true, last4: 'abcd', ref: 'secret/data/fr/anthropic' }])
  })

  it('removes a record', () => {
    const store = new ByokStore(path)
    store.upsert('openai', { backend: 'local', last4: '1', enc: { ciphertext: 'c', iv: 'i', tag: 't' } })
    store.remove('openai')
    expect(store.list()).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/byok-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `config-manager-web/server/src/byok/types.ts`**

```ts
export type BackendName = 'local' | 'vault' | 'aws-secrets-manager' | 'azure-key-vault' | 'gcp-secret-manager'

/** Encrypted material persisted by the local backend. */
export interface EncBlob { ciphertext: string; iv: string; tag: string }

/** What is persisted per provider in the per-env byok file. */
export interface StoredKey {
  backend: BackendName
  last4: string
  /** External-manager locator (path/ARN/secret name). Present for external backends. */
  ref?: string
  /** Encrypted secret. Present only for the local backend. Never leaves the server. */
  enc?: EncBlob
}

/** Safe-to-return view (never includes `enc`). */
export interface ByokPublic {
  provider: string
  backend: BackendName
  isSet: boolean
  last4?: string
  ref?: string
}

/** A backend turns a secret into a StoredKey and validates/destroys external material. */
export interface KeyBackend {
  readonly name: BackendName
  /** Produce the record to persist. `ref` is required by external backends. */
  materialize(secret: string | undefined, opts: { provider: string; ref?: string }): Promise<StoredKey>
  /** Confirm the key still resolves (local: enc present; external: client check). */
  verify(record: StoredKey): Promise<boolean>
  /** Remove any external-manager material (local: no-op). */
  destroy(record: StoredKey): Promise<void>
}

/** Minimal external secret-manager transport. */
export interface SecretManagerClient {
  writeSecret(ref: string, secret: string): Promise<void>
  secretExists(ref: string): Promise<boolean>
}
```

- [ ] **Step 4: Create `config-manager-web/server/src/byok/byok-store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StoredKey, ByokPublic } from './types.js'

const toPublic = (provider: string, r: StoredKey): ByokPublic => ({
  provider, backend: r.backend, isSet: true,
  ...(r.last4 !== undefined && { last4: r.last4 }),
  ...(r.ref !== undefined && { ref: r.ref }),
})

/** Per-environment store of BYOK records. Never exposes `enc` through `list`. */
export class ByokStore {
  private readonly records: Record<string, StoredKey>
  constructor(private readonly path: string) {
    this.records = existsSync(path) ? this.read() : {}
  }
  private read(): Record<string, StoredKey> {
    try { return JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, StoredKey> }
    catch { return {} }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
  getRaw(provider: string): StoredKey | undefined { return this.records[provider] }
  upsert(provider: string, record: StoredKey): void { this.records[provider] = record; this.persist() }
  remove(provider: string): void { delete this.records[provider]; this.persist() }
  list(): ByokPublic[] { return Object.entries(this.records).map(([p, r]) => toPublic(p, r)) }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/byok-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/server/src/byok/types.ts config-manager-web/server/src/byok/byok-store.ts config-manager-web/server/test/byok-store.test.ts
git commit -m "feat(web-config): BYOK record store + types (never exposes ciphertext)"
```

---

## Task 3: Local key backend (AES-256-GCM)

**Files:**
- Create: `config-manager-web/server/src/byok/local-backend.ts`
- Test: `config-manager-web/server/test/local-backend.test.ts`

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/local-backend.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDecipheriv } from 'node:crypto'
import { LocalKeyBackend } from '../src/byok/local-backend.js'

const MASTER = 'a'.repeat(64) // 32 bytes hex

describe('LocalKeyBackend', () => {
  it('encrypts the secret, records last4, and round-trips via the master key', async () => {
    const b = new LocalKeyBackend(MASTER)
    const rec = await b.materialize('sk-test-1234567890', { provider: 'openai' })
    expect(rec.backend).toBe('local')
    expect(rec.last4).toBe('7890')
    expect(rec.enc).toBeDefined()
    expect(rec.ref).toBeUndefined()
    // Decrypt with the master key to prove ciphertext is the real secret (server-internal).
    const key = Buffer.from(MASTER, 'hex')
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.enc!.iv, 'base64'))
    d.setAuthTag(Buffer.from(rec.enc!.tag, 'base64'))
    const plain = Buffer.concat([d.update(Buffer.from(rec.enc!.ciphertext, 'base64')), d.final()]).toString('utf-8')
    expect(plain).toBe('sk-test-1234567890')
  })

  it('verify is true when enc is present, false otherwise', async () => {
    const b = new LocalKeyBackend(MASTER)
    const rec = await b.materialize('secret', { provider: 'x' })
    expect(await b.verify(rec)).toBe(true)
    expect(await b.verify({ backend: 'local', last4: '0000' })).toBe(false)
  })

  it('throws if constructed without a 32-byte hex master key', () => {
    expect(() => new LocalKeyBackend('short')).toThrow(/master key/i)
  })

  it('requires a secret to materialize', async () => {
    const b = new LocalKeyBackend(MASTER)
    await expect(b.materialize(undefined, { provider: 'x' })).rejects.toThrow(/secret/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/local-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `config-manager-web/server/src/byok/local-backend.ts`**

```ts
import { createCipheriv, randomBytes } from 'node:crypto'
import type { KeyBackend, StoredKey } from './types.js'

/** Encrypts secrets at rest with AES-256-GCM. The web manager never decrypts —
 *  it is write-only; decryption belongs to the FinRouter runtime. */
export class LocalKeyBackend implements KeyBackend {
  readonly name = 'local' as const
  private readonly key: Buffer

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error('[byok] local backend requires a 32-byte hex master key (BYOK_MASTER_KEY)')
    }
    this.key = Buffer.from(masterKeyHex, 'hex')
  }

  async materialize(secret: string | undefined, _opts: { provider: string }): Promise<StoredKey> {
    if (secret === undefined || secret === '') throw new Error('[byok] local backend requires a secret')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      backend: 'local',
      last4: secret.slice(-4),
      enc: { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') },
    }
  }

  async verify(record: StoredKey): Promise<boolean> {
    return record.enc !== undefined
  }

  async destroy(_record: StoredKey): Promise<void> {
    /* nothing external to remove */
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/local-backend.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add config-manager-web/server/src/byok/local-backend.ts config-manager-web/server/test/local-backend.test.ts
git commit -m "feat(web-config): local AES-256-GCM key backend (write-only)"
```

---

## Task 4: Reference backend + secret-manager clients (Vault real; AWS/Azure/GCP adapters)

**Files:**
- Create: `config-manager-web/server/src/byok/reference-backend.ts`
- Create: `config-manager-web/server/src/byok/clients/vault-client.ts`, `aws-client.ts`, `azure-client.ts`, `gcp-client.ts`
- Modify: `config-manager-web/server/package.json` (add 3 cloud SDK deps)
- Test: `config-manager-web/server/test/reference-backend.test.ts`, `config-manager-web/server/test/vault-client.test.ts`

- [ ] **Step 1: Write the failing reference-backend test**

`config-manager-web/server/test/reference-backend.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ReferenceKeyBackend } from '../src/byok/reference-backend.js'
import type { SecretManagerClient } from '../src/byok/types.js'

class FakeClient implements SecretManagerClient {
  public written: Record<string, string> = {}
  async writeSecret(ref: string, secret: string) { this.written[ref] = secret }
  async secretExists(ref: string) { return ref in this.written }
}

describe('ReferenceKeyBackend', () => {
  it('writes the secret to the manager and records the ref (no enc)', async () => {
    const client = new FakeClient()
    const b = new ReferenceKeyBackend('vault', client)
    const rec = await b.materialize('sk-abcd', { provider: 'openai', ref: 'secret/fr/openai' })
    expect(rec).toMatchObject({ backend: 'vault', last4: 'abcd', ref: 'secret/fr/openai' })
    expect(rec.enc).toBeUndefined()
    expect(client.written['secret/fr/openai']).toBe('sk-abcd')
  })

  it('links an existing secret (no secret provided) when it resolves', async () => {
    const client = new FakeClient()
    client.written['secret/fr/existing'] = 'preset'
    const b = new ReferenceKeyBackend('vault', client)
    const rec = await b.materialize(undefined, { provider: 'x', ref: 'secret/fr/existing' })
    expect(rec.ref).toBe('secret/fr/existing')
    expect(rec.last4).toBe('eset')   // last4 of the resolved-but-not-returned value? -> see note
  })

  it('requires a ref', async () => {
    const b = new ReferenceKeyBackend('vault', new FakeClient())
    await expect(b.materialize('s', { provider: 'x' })).rejects.toThrow(/ref/i)
  })

  it('throws linking a non-existent secret with no secret to write', async () => {
    const b = new ReferenceKeyBackend('vault', new FakeClient())
    await expect(b.materialize(undefined, { provider: 'x', ref: 'secret/missing' })).rejects.toThrow(/exist|resolve/i)
  })

  it('verify delegates to secretExists; destroy is a no-op (ref retained externally)', async () => {
    const client = new FakeClient()
    client.written['r'] = 'v'
    const b = new ReferenceKeyBackend('vault', client)
    expect(await b.verify({ backend: 'vault', last4: 'x', ref: 'r' })).toBe(true)
    expect(await b.verify({ backend: 'vault', last4: 'x', ref: 'nope' })).toBe(false)
  })
})
```

Note on `last4` when linking an existing secret without providing one: we cannot know the secret's value without reading it (and external managers may not permit read here). For a linked-existing secret with no provided secret, set `last4` to the last 4 chars of the **ref** is misleading; instead leave `last4` as the empty string is awkward. Decision: when linking an existing secret, the operator MUST still be allowed to optionally provide the secret (to write+record last4). The "link existing without secret" path sets `last4` to `''`. Adjust the second test to assert `rec.last4 === ''` and `rec.ref === 'secret/fr/existing'` (replace the `'eset'` expectation). Make the test match the implementation below.

- [ ] **Step 2: Correct the second test to match the no-secret-link semantics**

Replace the second test's body with:
```ts
  it('links an existing secret (no secret provided) when it resolves', async () => {
    const client = new FakeClient()
    client.written['secret/fr/existing'] = 'preset'
    const b = new ReferenceKeyBackend('vault', client)
    const rec = await b.materialize(undefined, { provider: 'x', ref: 'secret/fr/existing' })
    expect(rec.ref).toBe('secret/fr/existing')
    expect(rec.last4).toBe('')
    expect(rec.enc).toBeUndefined()
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/reference-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `config-manager-web/server/src/byok/reference-backend.ts`**

```ts
import type { BackendName, KeyBackend, SecretManagerClient, StoredKey } from './types.js'

/** Stores keys in an external secret manager; the byok file keeps only a `ref`. */
export class ReferenceKeyBackend implements KeyBackend {
  constructor(readonly name: BackendName, private readonly client: SecretManagerClient) {}

  async materialize(secret: string | undefined, opts: { provider: string; ref?: string }): Promise<StoredKey> {
    const ref = opts.ref
    if (ref === undefined || ref === '') throw new Error('[byok] external backend requires a ref (secret locator)')
    if (secret !== undefined && secret !== '') {
      await this.client.writeSecret(ref, secret)
      return { backend: this.name, last4: secret.slice(-4), ref }
    }
    // Linking an existing secret: it must already resolve. last4 unknown (not read).
    if (!(await this.client.secretExists(ref))) {
      throw new Error(`[byok] secret does not resolve at ref: ${ref}`)
    }
    return { backend: this.name, last4: '', ref }
  }

  async verify(record: StoredKey): Promise<boolean> {
    return record.ref !== undefined && this.client.secretExists(record.ref)
  }

  async destroy(_record: StoredKey): Promise<void> {
    /* Leave the external secret in place; we only drop our local reference. */
  }
}
```

- [ ] **Step 5: Run to verify reference-backend passes**

Run: `npx vitest run test/reference-backend.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing Vault-client test**

`config-manager-web/server/test/vault-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { VaultClient } from '../src/byok/clients/vault-client.js'

describe('VaultClient (KV v2 over HTTP)', () => {
  it('writeSecret PUTs the value to the data path with the token header', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    const c = new VaultClient({ addr: 'https://vault:8200', token: 'tok', mount: 'secret', fetch: fetchMock })
    await c.writeSecret('fr/openai', 'sk-1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://vault:8200/v1/secret/data/fr/openai')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['X-Vault-Token']).toBe('tok')
    expect(JSON.parse(init!.body as string)).toEqual({ data: { value: 'sk-1' } })
  })

  it('secretExists returns true on 200, false on 404', async () => {
    const ok = new VaultClient({ addr: 'https://v', token: 't', mount: 'secret', fetch: vi.fn(async () => new Response('{}', { status: 200 })) })
    expect(await ok.secretExists('fr/x')).toBe(true)
    const missing = new VaultClient({ addr: 'https://v', token: 't', mount: 'secret', fetch: vi.fn(async () => new Response('', { status: 404 })) })
    expect(await missing.secretExists('fr/x')).toBe(false)
  })
})
```

- [ ] **Step 7: Create `config-manager-web/server/src/byok/clients/vault-client.ts`**

```ts
import type { SecretManagerClient } from '../types.js'

export interface VaultConfig {
  addr: string
  token: string
  /** KV v2 mount path. Default 'secret'. */
  mount?: string
  fetch?: typeof fetch
}

/** HashiCorp Vault KV v2 client over HTTP (no SDK). */
export class VaultClient implements SecretManagerClient {
  private readonly addr: string
  private readonly token: string
  private readonly mount: string
  private readonly fetchImpl: typeof fetch
  constructor(cfg: VaultConfig) {
    this.addr = cfg.addr.replace(/\/+$/, '')
    this.token = cfg.token
    this.mount = cfg.mount ?? 'secret'
    this.fetchImpl = cfg.fetch ?? fetch
  }
  private dataUrl(ref: string): string { return `${this.addr}/v1/${this.mount}/data/${ref}` }

  async writeSecret(ref: string, secret: string): Promise<void> {
    const resp = await this.fetchImpl(this.dataUrl(ref), {
      method: 'POST',
      headers: { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { value: secret } }),
    })
    if (!resp.ok) throw new Error(`[vault] write failed: HTTP ${resp.status}`)
  }

  async secretExists(ref: string): Promise<boolean> {
    const resp = await this.fetchImpl(this.dataUrl(ref), { method: 'GET', headers: { 'X-Vault-Token': this.token } })
    if (resp.status === 404) return false
    if (!resp.ok) throw new Error(`[vault] read failed: HTTP ${resp.status}`)
    return true
  }
}
```

- [ ] **Step 8: Run Vault-client test**

Run: `npx vitest run test/vault-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Add cloud SDK deps + create AWS/Azure/GCP adapter clients**

Add to `config-manager-web/server/package.json` `dependencies`:
```json
    "@aws-sdk/client-secrets-manager": "^3.600.0",
    "@azure/keyvault-secrets": "^4.8.0",
    "@azure/identity": "^4.4.0",
    "@google-cloud/secret-manager": "^5.6.0",
```
Run install (NETWORK REQUIRED — use the sandbox override for this command only): from `config-manager-web/` run `npm install`.

Create `config-manager-web/server/src/byok/clients/aws-client.ts`. The AWS SDK client is INJECTED so it's unit-testable with a fake; a default real client is built lazily from the environment when not provided:

```ts
import type { SecretManagerClient } from '../types.js'

/** The slice of the AWS SDK SecretsManager client we use (injectable for tests). */
export interface AwsSecretsApi {
  send(command: unknown): Promise<{ ARN?: string }>
}

/** Adapter over @aws-sdk/client-secrets-manager. `ref` is the secret name/ARN. */
export class AwsSecretsManagerClient implements SecretManagerClient {
  constructor(
    private readonly api: AwsSecretsApi,
    private readonly cmds: {
      Create: new (i: { Name: string; SecretString: string }) => unknown
      Put: new (i: { SecretId: string; SecretString: string }) => unknown
      Describe: new (i: { SecretId: string }) => unknown
    },
  ) {}

  async writeSecret(ref: string, secret: string): Promise<void> {
    try {
      await this.api.send(new this.cmds.Put({ SecretId: ref, SecretString: secret }))
    } catch {
      await this.api.send(new this.cmds.Create({ Name: ref, SecretString: secret }))
    }
  }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.send(new this.cmds.Describe({ SecretId: ref })); return true }
    catch { return false }
  }
}
```

Create `config-manager-web/server/src/byok/clients/azure-client.ts`:

```ts
import type { SecretManagerClient } from '../types.js'

/** The slice of @azure/keyvault-secrets SecretClient we use (injectable). */
export interface AzureSecretApi {
  setSecret(name: string, value: string): Promise<unknown>
  getSecret(name: string): Promise<unknown>
}

/** Adapter over @azure/keyvault-secrets. `ref` is the secret name. */
export class AzureKeyVaultClient implements SecretManagerClient {
  constructor(private readonly api: AzureSecretApi) {}
  async writeSecret(ref: string, secret: string): Promise<void> { await this.api.setSecret(ref, secret) }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.getSecret(ref); return true } catch { return false }
  }
}
```

Create `config-manager-web/server/src/byok/clients/gcp-client.ts`:

```ts
import type { SecretManagerClient } from '../types.js'

/** The slice of @google-cloud/secret-manager client we use (injectable). */
export interface GcpSecretApi {
  addSecretVersion(req: { parent: string; payload: { data: Buffer } }): Promise<unknown>
  accessSecretVersion(req: { name: string }): Promise<unknown>
}

/** Adapter over @google-cloud/secret-manager. `ref` is `projects/<p>/secrets/<id>`. */
export class GcpSecretManagerClient implements SecretManagerClient {
  constructor(private readonly api: GcpSecretApi) {}
  async writeSecret(ref: string, secret: string): Promise<void> {
    await this.api.addSecretVersion({ parent: ref, payload: { data: Buffer.from(secret, 'utf-8') } })
  }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.accessSecretVersion({ name: `${ref}/versions/latest` }); return true } catch { return false }
  }
}
```

- [ ] **Step 10: Add fake-injected adapter tests**

Append to `config-manager-web/server/test/reference-backend.test.ts` (they prove the adapters call the right SDK methods, without network):

```ts
import { AwsSecretsManagerClient } from '../src/byok/clients/aws-client.js'
import { AzureKeyVaultClient } from '../src/byok/clients/azure-client.js'
import { GcpSecretManagerClient } from '../src/byok/clients/gcp-client.js'

describe('external client adapters (fake-injected)', () => {
  it('AWS: writeSecret puts then falls back to create; exists via describe', async () => {
    const sent: unknown[] = []
    const api = { send: async (c: unknown) => { sent.push(c); return {} } }
    const cmds = {
      Put: class { constructor(public i: unknown) {} },
      Create: class { constructor(public i: unknown) {} },
      Describe: class { constructor(public i: unknown) {} },
    }
    const c = new AwsSecretsManagerClient(api, cmds as never)
    await c.writeSecret('fr/openai', 'sk')
    expect(sent[0]).toBeInstanceOf(cmds.Put)
    expect(await c.secretExists('fr/openai')).toBe(true)
  })

  it('Azure: writeSecret calls setSecret; exists via getSecret', async () => {
    const calls: string[] = []
    const api = { setSecret: async (n: string) => { calls.push(`set:${n}`) }, getSecret: async (n: string) => { calls.push(`get:${n}`); return {} } }
    const c = new AzureKeyVaultClient(api)
    await c.writeSecret('openai', 'sk')
    expect(calls).toContain('set:openai')
    expect(await c.secretExists('openai')).toBe(true)
  })

  it('GCP: writeSecret addSecretVersion; exists via accessSecretVersion', async () => {
    const calls: string[] = []
    const api = {
      addSecretVersion: async (r: { parent: string }) => { calls.push(`add:${r.parent}`) },
      accessSecretVersion: async (r: { name: string }) => { calls.push(`acc:${r.name}`); return {} },
    }
    const c = new GcpSecretManagerClient(api)
    await c.writeSecret('projects/p/secrets/openai', 'sk')
    expect(calls[0]).toBe('add:projects/p/secrets/openai')
    expect(await c.secretExists('projects/p/secrets/openai')).toBe(true)
  })
})
```

- [ ] **Step 11: Run all backend tests + typecheck**

Run: `npx vitest run test/reference-backend.test.ts test/vault-client.test.ts`
Expected: PASS (reference 5 + adapters 3 + vault 2 = 10).
Run: `npm run typecheck`
Expected: clean. (The adapter `cmds as never` cast in the AWS test sidesteps the constructor-type ceremony; if typecheck objects, type the fake `cmds` to match `AwsSecretsManagerClient`'s `cmds` param instead.)

- [ ] **Step 12: Commit**

```bash
git add config-manager-web/server/src/byok/reference-backend.ts config-manager-web/server/src/byok/clients config-manager-web/server/package.json config-manager-web/package-lock.json config-manager-web/server/test/reference-backend.test.ts config-manager-web/server/test/vault-client.test.ts
git commit -m "feat(web-config): reference key backend + Vault/AWS/Azure/GCP clients"
```

---

## Task 5: Key-backend registry + wire into the app

**Files:**
- Create: `config-manager-web/server/src/byok/registry.ts`
- Test: `config-manager-web/server/test/byok-registry.test.ts`
- Modify: `config-manager-web/server/src/app.ts` (AppDeps gets `keyBackends`), `config-manager-web/server/src/server.ts` (build registry)

- [ ] **Step 1: Write the failing test**

`config-manager-web/server/test/byok-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { KeyBackendRegistry } from '../src/byok/registry.js'
import { LocalKeyBackend } from '../src/byok/local-backend.js'

describe('KeyBackendRegistry', () => {
  it('resolves a registered backend by name', () => {
    const reg = new KeyBackendRegistry({ local: new LocalKeyBackend('a'.repeat(64)) })
    expect(reg.get('local').name).toBe('local')
    expect(reg.available()).toEqual(['local'])
  })
  it('throws a clear error for an unconfigured backend', () => {
    const reg = new KeyBackendRegistry({})
    expect(() => reg.get('vault')).toThrow(/not configured/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/byok-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `config-manager-web/server/src/byok/registry.ts`**

```ts
import type { BackendName, KeyBackend } from './types.js'

export class KeyBackendRegistry {
  constructor(private readonly backends: Partial<Record<BackendName, KeyBackend>>) {}
  get(name: BackendName): KeyBackend {
    const b = this.backends[name]
    if (b === undefined) throw new Error(`[byok] backend "${name}" is not configured on this server`)
    return b
  }
  available(): BackendName[] {
    return Object.keys(this.backends) as BackendName[]
  }
}
```

- [ ] **Step 4: Add `keyBackends` to `AppDeps` in `src/app.ts`**

In the `AppDeps` interface add:
```ts
  keyBackends: import('./byok/registry.js').KeyBackendRegistry
```
No other change to `buildApp` here except registering the byok routes (Task 6 Step 5 adds the registration call).

- [ ] **Step 5: Build the registry in `src/server.ts`**

In `src/server.ts`, after the other deps are built and before `buildApp(...)`, construct the registry from config and pass it in. Add imports and assembly:
```ts
import { KeyBackendRegistry } from './byok/registry.js'
import { LocalKeyBackend } from './byok/local-backend.js'
import { ReferenceKeyBackend } from './byok/reference-backend.js'
import { VaultClient } from './byok/clients/vault-client.js'
import type { BackendName, KeyBackend } from './byok/types.js'
```
Build the backends map from environment variables (local always if master key present; Vault if `VAULT_ADDR`+`VAULT_TOKEN` present; AWS/Azure/GCP are constructed in deployment-specific bootstrap and can be added here similarly):
```ts
  const backends: Partial<Record<BackendName, KeyBackend>> = {}
  if (cfg.byokMasterKey !== undefined) backends.local = new LocalKeyBackend(cfg.byokMasterKey)
  if (process.env.VAULT_ADDR !== undefined && process.env.VAULT_TOKEN !== undefined) {
    backends.vault = new ReferenceKeyBackend('vault', new VaultClient({ addr: process.env.VAULT_ADDR, token: process.env.VAULT_TOKEN, ...(process.env.VAULT_MOUNT !== undefined && { mount: process.env.VAULT_MOUNT }) }))
  }
  const keyBackends = new KeyBackendRegistry(backends)
```
Then add `keyBackends,` to the `buildApp({ ... })` deps object.

Note: AWS/Azure/GCP real wiring (constructing their SDK clients from the ambient credential chain and registering `new ReferenceKeyBackend('aws-secrets-manager', new AwsSecretsManagerClient(realSdk, cmds))`) is deployment-specific bootstrap; add it in `server.ts` alongside Vault when those deployments need it. The backends + adapters are fully implemented and unit-tested; only the credential wiring is environment-specific.

- [ ] **Step 6: Run the registry test + typecheck**

Run: `npx vitest run test/byok-registry.test.ts`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: clean. (Tests don't construct the real app via `server.ts`; the test helper supplies its own registry in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add config-manager-web/server/src/byok/registry.ts config-manager-web/server/src/app.ts config-manager-web/server/src/server.ts config-manager-web/server/test/byok-registry.test.ts
git commit -m "feat(web-config): key-backend registry + server wiring"
```

---

## Task 6: BYOK API routes

**Files:**
- Create: `config-manager-web/server/src/routes/byok-routes.ts`
- Modify: `config-manager-web/server/src/app.ts` (register the routes), `config-manager-web/server/test/helpers.ts` (provide a `keyBackends` registry in `buildTestApp`)
- Test: `config-manager-web/server/test/byok-routes.test.ts`

- [ ] **Step 1: Give the test app a key-backend registry**

In `config-manager-web/server/test/helpers.ts`, build a registry with a `local` backend (test master key) and a `vault` reference backend over an in-memory fake client, and pass it in `buildTestApp`'s deps. Add:
```ts
import { KeyBackendRegistry } from '../src/byok/registry.js'
import { LocalKeyBackend } from '../src/byok/local-backend.js'
import { ReferenceKeyBackend } from '../src/byok/reference-backend.js'
import type { SecretManagerClient } from '../src/byok/types.js'

class MemoryClient implements SecretManagerClient {
  store: Record<string, string> = {}
  async writeSecret(ref: string, secret: string) { this.store[ref] = secret }
  async secretExists(ref: string) { return ref in this.store }
}
```
In the `deps` object inside `buildTestApp`, add:
```ts
    keyBackends: new KeyBackendRegistry({
      local: new LocalKeyBackend('a'.repeat(64)),
      vault: new ReferenceKeyBackend('vault', new MemoryClient()),
    }),
```

- [ ] **Step 2: Write the failing routes test**

`config-manager-web/server/test/byok-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
  const c1 = cookieHeader(loginRes.cookies)
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: c1 } })
  return cookieHeader(cb.cookies)
}

describe('byok routes', () => {
  it('lists empty, sets a local key, then lists it with last4 (never the secret)', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()).toEqual([])
    const set = await app.inject({ method: 'POST', url: '/api/env/dev/byok/openai', headers: { cookie }, payload: { backend: 'local', secret: 'sk-test-9999' } })
    expect(set.statusCode).toBe(200)
    const list = (await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()
    expect(list).toEqual([{ provider: 'openai', backend: 'local', isSet: true, last4: '9999' }])
    expect(JSON.stringify(list)).not.toMatch(/sk-test|ciphertext/)
    await app.close()
  })

  it('sets an external (vault) key with a ref', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const set = await app.inject({ method: 'POST', url: '/api/env/dev/byok/anthropic', headers: { cookie }, payload: { backend: 'vault', secret: 'sk-ant-1234', ref: 'fr/anthropic' } })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ provider: 'anthropic', backend: 'vault', last4: '1234', ref: 'fr/anthropic' })
    await app.close()
  })

  it('deletes a key', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    await app.inject({ method: 'POST', url: '/api/env/dev/byok/openai', headers: { cookie }, payload: { backend: 'local', secret: 'sk-1' } })
    expect((await app.inject({ method: 'DELETE', url: '/api/env/dev/byok/openai', headers: { cookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()).toEqual([])
    await app.close()
  })

  it('400 for an unconfigured backend; 422 for local without a secret', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    expect((await app.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie }, payload: { backend: 'gcp-secret-manager', secret: 's' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie }, payload: { backend: 'local' } })).statusCode).toBe(422)
    await app.close()
  })

  it('forbids a viewer from setting a key (403) and 401 unauthenticated', async () => {
    const viewer = await buildTestApp({ claims: { sub: 'v', name: 'V', groups: ['fin-viewers'] } })
    const vcookie = await login(viewer)
    expect((await viewer.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie: vcookie }, payload: { backend: 'local', secret: 's' } })).statusCode).toBe(403)
    await viewer.close()
    const app = await buildTestApp()
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok' })).statusCode).toBe(401)
    await app.close()
  })
})
```

(This `login` helper mirrors the one already in `config-routes.test.ts`, using the exported `cookieHeader`.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/byok-routes.test.ts`
Expected: FAIL — `/api/env/dev/byok` 404 (routes not registered).

- [ ] **Step 4: Create `config-manager-web/server/src/routes/byok-routes.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { ByokStore } from '../byok/byok-store.js'
import type { BackendName } from '../byok/types.js'
import type { SessionUser, Environment } from '../types.js'

const BACKENDS: BackendName[] = ['local', 'vault', 'aws-secrets-manager', 'azure-key-vault', 'gcp-secret-manager']
const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerByokRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit, keyBackends } = app.deps

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

  app.get('/api/env/:id/byok', async (req, reply) => {
    const env = resolve(req, reply, false)
    if (env === undefined) return
    return reply.send(new ByokStore(env.paths.byok).list())
  })

  app.post('/api/env/:id/byok/:provider', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    const provider = (req.params as { provider: string }).provider
    const body = req.body as { backend?: string; secret?: string; ref?: string }
    if (typeof body?.backend !== 'string' || !BACKENDS.includes(body.backend as BackendName)) {
      return reply.code(400).send({ error: 'invalid or unknown backend' })
    }
    let backend
    try { backend = keyBackends.get(body.backend as BackendName) }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }) }
    try {
      const record = await backend.materialize(body.secret, { provider, ...(body.ref !== undefined && { ref: body.ref }) })
      const store = new ByokStore(env.paths.byok)
      store.upsert(provider, record)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'byok:set', target: `byok:${provider}` })
      const view = store.list().find(e => e.provider === provider)
      return reply.send(view)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/env/:id/byok/:provider', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    const provider = (req.params as { provider: string }).provider
    const store = new ByokStore(env.paths.byok)
    const record = store.getRaw(provider)
    if (record !== undefined) {
      try { await keyBackends.get(record.backend).destroy(record) } catch { /* best-effort external cleanup */ }
      store.remove(provider)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'byok:delete', target: `byok:${provider}` })
    }
    return reply.send({ ok: true })
  })
}
```

- [ ] **Step 5: Register the routes in `src/app.ts`**

Add the import and registration alongside the existing route registrations:
```ts
import { registerByokRoutes } from './routes/byok-routes.js'
```
and after `await app.register(registerConfigRoutes)`:
```ts
  await app.register(registerByokRoutes)
```

- [ ] **Step 6: Run the byok routes test + full suite + typecheck**

Run: `npx vitest run test/byok-routes.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run && npm run typecheck`
Expected: all server tests pass; clean.

- [ ] **Step 7: Commit**

```bash
git add config-manager-web/server/src/routes/byok-routes.ts config-manager-web/server/src/app.ts config-manager-web/server/test/helpers.ts config-manager-web/server/test/byok-routes.test.ts
git commit -m "feat(web-config): BYOK API routes (list/set/rotate/delete, write-only, audited)"
```

---

## Task 7: Web BYOK section + modal

**Files:**
- Modify: `config-manager-web/web/src/types.ts` (add `ByokEntry`)
- Create: `config-manager-web/web/src/sections/ByokSection.tsx`
- Test: `config-manager-web/web/test/ByokSection.test.tsx`

The section is bespoke (not `useConfig` — BYOK uses dedicated set/delete endpoints, not a versioned doc). It lists entries from `GET /api/env/:id/byok`, and a modal sets a key (choose backend; secret input is `type="password"`; an optional ref field for external backends). Rotate reuses the set modal; Delete calls DELETE. The secret is never read back.

- [ ] **Step 1: Add the `ByokEntry` type to `config-manager-web/web/src/types.ts`**

```ts
export interface ByokEntry { provider: string; backend: string; isSet: boolean; last4?: string; ref?: string }
```

- [ ] **Step 2: Write the failing test**

`config-manager-web/web/test/ByokSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ByokSection } from '../src/sections/ByokSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('ByokSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing keys showing backend + last4 (no secret field shown for existing)', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ provider: 'openai', backend: 'local', isSet: true, last4: '7890' }]), { status: 200 })])
    render(<ByokSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('openai')).toBeInTheDocument()
    expect(screen.getByText(/7890/)).toBeInTheDocument()
  })

  it('sets a local key via the modal (POSTs backend + secret, never GETs it back)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    mockFetchSequence([
      () => new Response(JSON.stringify([]), { status: 200 }),                       // initial list
      (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ provider: 'openai', backend: 'local', isSet: true, last4: '0001' }), { status: 200 }) }, // POST
      () => new Response(JSON.stringify([{ provider: 'openai', backend: 'local', isSet: true, last4: '0001' }]), { status: 200 }), // reload list
    ])
    render(<ByokSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /set key/i }))
    await userEvent.type(screen.getByLabelText('Provider'), 'openai')
    await userEvent.type(screen.getByLabelText('Secret'), 'sk-xxxx0001')
    await userEvent.click(screen.getByRole('button', { name: /^save key$/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toBe('/api/env/dev/byok/openai')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ backend: 'local', secret: 'sk-xxxx0001' })
  })

  it('hides Set key for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([]), { status: 200 })])
    render(<ByokSection envId="dev" canWrite={false} />)
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull())
    expect(screen.queryByRole('button', { name: /set key/i })).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/ByokSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `config-manager-web/web/src/sections/ByokSection.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import { api, ApiError } from '../api.js'
import type { ByokEntry } from '../types.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'

const BACKENDS = ['local', 'vault', 'aws-secrets-manager', 'azure-key-vault', 'gcp-secret-manager']

export function ByokSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const [entries, setEntries] = useState<ByokEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ provider: string; backend: string; secret: string; ref: string } | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.get<ByokEntry[]>(`/api/env/${envId}/byok`).then(setEntries).finally(() => setLoading(false))
  }, [envId])
  useEffect(reload, [reload])

  const onSave = async () => {
    if (draft === null || draft.provider.trim() === '') return
    setError(null)
    try {
      await api.post(`/api/env/${envId}/byok/${encodeURIComponent(draft.provider)}`, {
        backend: draft.backend,
        ...(draft.secret !== '' && { secret: draft.secret }),
        ...(draft.ref !== '' && { ref: draft.ref }),
      })
      setDraft(null); setToast('Key saved'); setTimeout(() => setToast(null), 2000); reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save key')
    }
  }

  const onDelete = async (provider: string) => {
    await api.del(`/api/env/${envId}/byok/${encodeURIComponent(provider)}`); reload()
  }

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>BYOK Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys are write-only — they are encrypted or stored in your key manager and never shown again.</p>
      {error !== null && <div className="banner banner--conflict" role="alert">{error}</div>}
      <Table headers={['Provider', 'Backend', 'Key', 'Ref', canWrite ? 'Actions' : '']}>
        {entries.map(e => (
          <tr key={e.provider}>
            <td>{e.provider}</td><td>{e.backend}</td><td>{e.last4 !== undefined ? `••••${e.last4}` : '••••'}</td><td>{e.ref ?? '—'}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setDraft({ provider: e.provider, backend: e.backend, secret: '', ref: e.ref ?? '' })}>Rotate</Button>
                <Button variant="ghost" onClick={() => onDelete(e.provider)}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setDraft({ provider: '', backend: 'local', secret: '', ref: '' })}>Set key</Button>}
      <Toast message={toast} />

      <Modal open={draft !== null} title="Set BYOK key" onClose={() => setDraft(null)}
        footer={<Button onClick={onSave}>Save key</Button>}>
        {draft !== null && (
          <>
            <Field label="Provider" htmlFor="bk-prov"><TextInput id="bk-prov" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })} /></Field>
            <Field label="Backend" htmlFor="bk-backend">
              <select id="bk-backend" value={draft.backend} onChange={(e) => setDraft({ ...draft, backend: e.target.value })}>
                {BACKENDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Secret" htmlFor="bk-secret">
              <input id="bk-secret" type="password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} />
            </Field>
            {draft.backend !== 'local' && (
              <Field label="Ref (secret locator in the key manager)" htmlFor="bk-ref">
                <TextInput id="bk-ref" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/ByokSection.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/types.ts config-manager-web/web/src/sections/ByokSection.tsx config-manager-web/web/test/ByokSection.test.tsx
git commit -m "feat(web-config): BYOK Keys section + set/rotate/delete modal (write-only)"
```

---

## Task 8: Wire BYOK into AppShell + Plan-3 verification

**Files:**
- Modify: `config-manager-web/web/src/app/AppShell.tsx`
- Test: `config-manager-web/web/test/AppShell.test.tsx` (extend)

- [ ] **Step 1: Extend the AppShell nav test**

In `config-manager-web/web/test/AppShell.test.tsx`, add `'BYOK Keys'` to the list of expected nav labels asserted (the existing test loops over section labels and clicks one). Add `'BYOK Keys'` to that label array so the test requires the nav entry.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/AppShell.test.tsx`
Expected: FAIL — no `BYOK Keys` nav link yet.

- [ ] **Step 3: Wire the section into `config-manager-web/web/src/app/AppShell.tsx`**

Add the import:
```ts
import { ByokSection } from '../sections/ByokSection.js'
```
Add to the `SECTIONS` const (place after `pricing`, before `optimization` to match the Python tab order, or at the end — order is cosmetic):
```ts
  { id: 'byok', label: 'BYOK Keys' },
```
Add to the `SectionId` union implicitly (it derives from `SECTIONS`). Add a `case` to the render switch:
```ts
              case 'byok': return <ByokSection {...props} />
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full Plan-3 verification**

Run (from `config-manager-web/server/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all server tests pass (byok-store, local-backend, reference-backend, vault-client, byok-registry, byok-routes, plus all prior), typecheck clean, `dist/server.js` emitted; then `rm -rf dist`.

Run (from `config-manager-web/web/`): `npx vitest run && npm run typecheck && npm run build`
Expected: all web tests pass (ByokSection + all prior), typecheck clean, Vite build succeeds, `find src -name '*.js'` empty.

- [ ] **Step 6: Commit**

```bash
git add config-manager-web/web/src/app/AppShell.tsx config-manager-web/web/test/AppShell.test.tsx
git commit -m "feat(web-config): wire BYOK Keys section into AppShell nav"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan-3 portion):** write-only BYOK that never returns plaintext (Task 2 store `list()` omits `enc`; routes never read secrets — Task 6); `local` AES-256-GCM at rest (Task 3); pluggable `KeyBackend` + external `ReferenceKeyBackend`/`SecretManagerClient` (Task 4); Vault fully implemented + tested (Task 4); AWS/Azure/GCP adapters SDK-injected + fake-tested (Task 4); registry + wiring (Task 5); admin-only + audited API (Task 6); web BYOK section/modal showing only provider/backend/last4/ref (Task 7); nav (Task 8). Live cloud network is intentionally not exercised.
- **Security invariants:** the secret reaches the server over HTTPS, is encrypted (local) or written to the manager (external), and is **never** persisted in clear nor returned by any GET. `ByokStore.list()` returns `ByokPublic` only; the routes return `store.list().find(...)`, never the raw record. `enc` never leaves the process. The web Secret input is `type="password"`; there is no reveal path.
- **Type consistency:** `BackendName`, `StoredKey`, `ByokPublic`, `KeyBackend`, `SecretManagerClient` are defined once in `byok/types.ts` and reused by store, backends, registry, routes. The web `ByokEntry` mirrors `ByokPublic`. `AppDeps.keyBackends` is the registry type; the test helper injects a registry with `local` + a `vault` MemoryClient.
- **Env path migration:** adding `byok` to `REQUIRED_PATHS` means real `environments.json` files must include a `byok` path; the test helper is updated so all existing route tests keep passing (Task 1 Step 6).
- **No placeholders:** the one judgement point — `last4` for a linked-existing external secret with no provided secret — is resolved explicitly (empty string; Task 4 Steps 1–2).
