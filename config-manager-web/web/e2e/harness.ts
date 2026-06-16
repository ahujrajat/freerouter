import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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
    spend: join(dir, 'spend.jsonl'),
  }
  const envFile = join(dir, 'environments.json')
  writeFileSync(envFile, JSON.stringify([{ id: 'dev', label: 'Development', paths }]))
  // Seed a candidate so the Candidates e2e has a row to optimize.
  writeFileSync(paths.candidates, JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 7, totalCostUsd: 0.3, lastSeen: 1, estPredictedSavingsUsd: 0.06, estBreakEvenReqs: 5, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }]))
  // Seed spend records so the Reporting e2e has data to display.
  const now = Date.now()
  const spendRecords = [
    { userId: 'alice', teamId: 'eng', provider: 'openai', model: 'gpt-4o', costUsd: 0.05, tokens: { totalTokens: 2000 }, timestamp: now - 3600000 },
    { userId: 'bob', teamId: 'eng', provider: 'anthropic', model: 'claude-3-5-sonnet', costUsd: 0.08, tokens: { totalTokens: 3500 }, timestamp: now - 7200000 },
    { userId: 'alice', teamId: 'design', provider: 'openai', model: 'gpt-4o-mini', costUsd: 0.02, tokens: { totalTokens: 800 }, timestamp: now - 10800000 },
  ]
  writeFileSync(paths.spend, spendRecords.map(r => JSON.stringify(r)).join('\n'))

  const HERE = dirname(fileURLToPath(import.meta.url))
  const webDist = resolve(HERE, '..', 'dist')
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

// Entry point for Playwright's webServer command: `node --import tsx e2e/harness.ts`
if (process.argv[1]?.endsWith('harness.ts')) {
  const port = Number(process.env.E2E_PORT ?? '7799')
  startHarness(port).then(() => {
    // eslint-disable-next-line no-console
    console.log(`[e2e] harness listening on ${port}`)
  }).catch((e) => { console.error(e); process.exit(1) })
}
