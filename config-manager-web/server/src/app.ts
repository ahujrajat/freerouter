import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import secureSession from '@fastify/secure-session'
import { createHash } from 'node:crypto'
import type { OidcProvider } from './auth/oidc.js'
import type { EnvironmentRegistry } from './environments.js'
import type { RoleResolver } from './auth/rbac.js'
import type { AuditLog } from './store/audit-log.js'
import { registerAuthRoutes } from './routes/auth-routes.js'
import { registerConfigRoutes } from './routes/config-routes.js'
import type { SessionUser } from './types.js'

export interface AppDeps {
  sessionSecret: string
  oidc: OidcProvider
  environments: EnvironmentRegistry
  roles: RoleResolver
  audit: AuditLog
  redirectUri: string
  afterLoginRedirect: string
  keyBackends: import('./byok/registry.js').KeyBackendRegistry
}

// Derive a 32-byte secure-session key deterministically from the secret.
const sessionKey = (secret: string): Buffer => createHash('sha256').update(secret).digest()

const SESSION_COOKIE_NAME = 'fr_admin_session'

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cookie)
  await app.register(secureSession, {
    key: sessionKey(deps.sessionSecret),
    cookieName: SESSION_COOKIE_NAME,
    cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
  })

  app.decorate('deps', deps)
  await app.register(registerAuthRoutes)
  await app.register(registerConfigRoutes)
  return app
}

declare module 'fastify' {
  interface FastifyInstance { deps: AppDeps }
}

declare module '@fastify/secure-session' {
  interface SessionData {
    user?: SessionUser
    oauth_state?: string
    oauth_nonce?: string
  }
}
