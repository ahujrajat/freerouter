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
