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
}

// Derive a 32-byte secure-session key deterministically from the secret.
const sessionKey = (secret: string): Buffer => createHash('sha256').update(secret).digest()

const SESSION_COOKIE_NAME = 'fr_admin_session'

/**
 * @fastify/secure-session encodes the session as "<cipher>;<nonce>" (base64 parts
 * separated by a literal semicolon). The @fastify/cookie serialiser URL-encodes
 * the semicolon to %3B in the outgoing Set-Cookie header, but the `set-cookie-parser`
 * used by Fastify's `inject()` helper URL-decodes it back, leaving a raw ";" in
 * res.cookies[i].value. When tests reconstruct "name=value" from that, the cookie
 * header contains a literal ";" which the standard cookie parser treats as a
 * key-value separator, truncating the nonce half and producing an empty session.
 *
 * This onRequest hook (registered before @fastify/cookie) detects that pattern
 * and re-encodes the raw ";" back to "%3B", so cookie.parse() receives a valid
 * percent-encoded value that it URL-decodes to the full "cipher;nonce" string.
 *
 * Production browsers always send the URL-encoded form from the Set-Cookie
 * header, so this hook is a no-op in production.
 */
function fixSecureSessionCookie(rawCookieHeader: string): string {
  // Match: <name>=<base64part>;<base64part>
  // Base64 chars: A-Za-z0-9 + / =  (standard alphabet used by sodium-native)
  const re = new RegExp(
    `\\b${SESSION_COOKIE_NAME}=([A-Za-z0-9+/=]*)(?:;([A-Za-z0-9+/=]+))?`,
  )
  return rawCookieHeader.replace(re, (_match, cipher: string, nonce: string | undefined) => {
    if (nonce === undefined) return _match  // No embedded ;, already URL-encoded or missing
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`${cipher};${nonce}`)}`
  })
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // Fix the session cookie before @fastify/cookie parses it (see comment above).
  app.addHook('onRequest', (req, _reply, done) => {
    const raw = req.raw.headers.cookie
    if (typeof raw === 'string') {
      req.raw.headers.cookie = fixSecureSessionCookie(raw)
    }
    done()
  })

  await app.register(cookie)
  await app.register(secureSession, {
    key: sessionKey(deps.sessionSecret),
    cookieName: SESSION_COOKIE_NAME,
    cookie: { path: '/', httpOnly: true, sameSite: 'lax' },
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
