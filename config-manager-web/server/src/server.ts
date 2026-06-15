import { loadServerConfig } from './config.js'
import { EnvironmentRegistry } from './environments.js'
import { RoleResolver, type RoleMapping } from './auth/rbac.js'
import { AuditLog } from './store/audit-log.js'
import { OpenIdConnectProvider } from './auth/oidc.js'
import { buildApp } from './app.js'
import { readFileSync } from 'node:fs'
import { KeyBackendRegistry } from './byok/registry.js'
import { LocalKeyBackend } from './byok/local-backend.js'
import { ReferenceKeyBackend } from './byok/reference-backend.js'
import { VaultClient } from './byok/clients/vault-client.js'
import type { BackendName, KeyBackend } from './byok/types.js'

async function main(): Promise<void> {
  const cfg = loadServerConfig()
  const environments = EnvironmentRegistry.load(cfg.environmentsFile)
  const roleMapping = JSON.parse(readFileSync(process.env.ROLE_MAPPING_FILE ?? './role-mapping.json', 'utf-8')) as RoleMapping
  const roles = new RoleResolver(roleMapping)
  const audit = new AuditLog(cfg.auditLogFile)
  const oidc = await OpenIdConnectProvider.create(cfg.oidc)

  const backends: Partial<Record<BackendName, KeyBackend>> = {}
  if (cfg.byokMasterKey !== undefined) backends.local = new LocalKeyBackend(cfg.byokMasterKey)
  if (process.env.VAULT_ADDR !== undefined && process.env.VAULT_TOKEN !== undefined) {
    backends.vault = new ReferenceKeyBackend('vault', new VaultClient({ addr: process.env.VAULT_ADDR, token: process.env.VAULT_TOKEN, ...(process.env.VAULT_MOUNT !== undefined && { mount: process.env.VAULT_MOUNT }) }))
  }
  const keyBackends = new KeyBackendRegistry(backends)

  const app = await buildApp({
    sessionSecret: cfg.sessionSecret,
    oidc, environments, roles, audit,
    redirectUri: cfg.oidc.redirectUri,
    afterLoginRedirect: '/',
    keyBackends,
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
