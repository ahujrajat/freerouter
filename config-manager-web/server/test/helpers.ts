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
