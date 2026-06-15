/**
 * Local development mode — boots the manager with ZERO required configuration
 * so an operator can click around without standing up an OIDC identity provider.
 *
 * Enabled by `FR_ADMIN_DEV=1` (the `npm run dev` script sets it). It uses a fake
 * OIDC provider that auto-completes login as a "Dev Admin", a temp environment
 * under `./.dev-data/`, an in-memory-ish local key backend, and the real pricing
 * fetcher. NEVER use this in production — there is no real authentication.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { EnvironmentRegistry } from './environments.js'
import { RoleResolver } from './auth/rbac.js'
import { AuditLog } from './store/audit-log.js'
import { KeyBackendRegistry } from './byok/registry.js'
import { LocalKeyBackend } from './byok/local-backend.js'
import { LibraryPricingFetcher } from './pricing/pricing-fetcher.js'
import { liteLLMPricingSource, openRouterPricingSource } from 'freerouter'
import type { AppDeps } from './app.js'
import type { OidcProvider, AuthRequest, Claims } from './auth/oidc.js'

/** Fake OIDC: `authUrl` bounces the browser straight back to the callback with
 *  the issued state, so `/auth/login` completes login without a real IdP. */
class DevOidcProvider implements OidcProvider {
  authUrl(req: AuthRequest): string {
    return `${req.redirectUri}?code=dev&state=${encodeURIComponent(req.state)}`
  }
  async exchange(): Promise<Claims> {
    return { sub: 'dev', name: 'Dev Admin', groups: ['dev-admins'] }
  }
}

export interface DevBoot { deps: AppDeps; port: number; webOrigin: string }

/** Build AppDeps for local dev. Creates `./.dev-data/` fixtures on first run. */
export function buildDevDeps(): DevBoot {
  const port = Number(process.env.PORT ?? '7700')
  // The browser-facing origin. With `npm run dev:web` (Vite on 5173 proxying
  // /api,/auth to this server), keep the default. If you serve the built SPA
  // from this server instead, set FR_ADMIN_DEV_ORIGIN=http://localhost:<port>.
  const webOrigin = process.env.FR_ADMIN_DEV_ORIGIN ?? 'http://localhost:5173'
  const dataDir = resolve(process.env.FR_ADMIN_DEV_DATA ?? './.dev-data')
  mkdirSync(join(dataDir, 'dev'), { recursive: true })

  const paths = {
    config: join(dataDir, 'dev', 'config.json'),
    rules: join(dataDir, 'dev', 'rules.json'),
    env: join(dataDir, 'dev', '.env'),
    pricing: join(dataDir, 'dev', 'pricing.json'),
    optimizedStore: join(dataDir, 'dev', 'optimized-prompts.json'),
    candidates: join(dataDir, 'dev', 'candidates.json'),
    byok: join(dataDir, 'dev', 'byok.json'),
  }
  const environmentsFile = join(dataDir, 'environments.json')
  if (!existsSync(environmentsFile)) {
    writeFileSync(environmentsFile, JSON.stringify([{ id: 'dev', label: 'Development', paths }], null, 2))
  }

  const deps: AppDeps = {
    sessionSecret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    oidc: new DevOidcProvider(),
    environments: EnvironmentRegistry.load(environmentsFile),
    roles: new RoleResolver({ defaults: { 'dev-admins': 'admin' } }),
    audit: new AuditLog(join(dataDir, 'audit.jsonl')),
    redirectUri: `${webOrigin}/auth/callback`,
    afterLoginRedirect: '/',
    keyBackends: new KeyBackendRegistry({
      local: new LocalKeyBackend(process.env.BYOK_MASTER_KEY ?? '0'.repeat(64)),
    }),
    pricingFetcher: new LibraryPricingFetcher({
      litellm: () => liteLLMPricingSource(),
      openrouter: () => openRouterPricingSource(),
    }),
    ...(process.env.WEB_DIST_DIR !== undefined && { webDistDir: process.env.WEB_DIST_DIR }),
  }
  return { deps, port, webOrigin }
}
