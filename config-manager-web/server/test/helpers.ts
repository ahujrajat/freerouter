import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type AppDeps } from '../src/app.js'
import { EnvironmentRegistry } from '../src/environments.js'
import { RoleResolver } from '../src/auth/rbac.js'
import { AuditLog } from '../src/store/audit-log.js'
import type { OidcProvider, Claims } from '../src/auth/oidc.js'
import { KeyBackendRegistry } from '../src/byok/registry.js'
import { LocalKeyBackend } from '../src/byok/local-backend.js'
import { ReferenceKeyBackend } from '../src/byok/reference-backend.js'
import type { SecretManagerClient } from '../src/byok/types.js'

class MemoryClient implements SecretManagerClient {
  store: Record<string, string> = {}
  async writeSecret(ref: string, secret: string) { this.store[ref] = secret }
  async secretExists(ref: string) { return ref in this.store }
}

export function makeTempEnv(): { dir: string; environmentsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fr-app-'))
  const paths = {
    config: join(dir, 'config.json'), rules: join(dir, 'rules.json'), env: join(dir, '.env'),
    pricing: join(dir, 'pricing.json'), optimizedStore: join(dir, 'opt.json'), candidates: join(dir, 'cand.json'),
    byok: join(dir, 'byok.json'),
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

/** Rebuild a Cookie request header from inject()'s parsed Set-Cookie list,
 *  re-encoding values the way a browser would replay them (so secure-session's
 *  `cipher;nonce` separator that set-cookie-parser URL-decoded to a literal ';'
 *  is restored to '%3B'). */
export function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ')
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
    keyBackends: new KeyBackendRegistry({
      local: new LocalKeyBackend('a'.repeat(64)),
      vault: new ReferenceKeyBackend('vault', new MemoryClient()),
    }),
  }
  return buildApp(deps)
}
