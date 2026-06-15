import type { ServerConfig } from './types.js'

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const v = env[key]
  if (v === undefined || v.trim() === '') {
    throw new Error(`[config] missing required environment variable: ${key}`)
  }
  return v
}

/** Build the server config from environment variables (defaults to process.env). */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const sessionSecret = required(env, 'SESSION_SECRET')
  if (sessionSecret.length < 32) {
    throw new Error('[config] SESSION_SECRET must be at least 32 characters')
  }
  return {
    port: env.PORT !== undefined ? Number(env.PORT) : 7700,
    sessionSecret,
    oidc: {
      issuer: required(env, 'OIDC_ISSUER'),
      clientId: required(env, 'OIDC_CLIENT_ID'),
      clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
      redirectUri: required(env, 'OIDC_REDIRECT_URI'),
      scopes: env.OIDC_SCOPES ?? 'openid profile email groups',
      groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups',
    },
    environmentsFile: required(env, 'ENVIRONMENTS_FILE'),
    auditLogFile: required(env, 'AUDIT_LOG_FILE'),
    ...(env.BYOK_MASTER_KEY !== undefined && { byokMasterKey: env.BYOK_MASTER_KEY }),
    ...(env.GEPA_SIDECAR_URL !== undefined && { gepaSidecarUrl: env.GEPA_SIDECAR_URL }),
    ...(env.GEPA_SIDECAR_TOKEN !== undefined && { gepaSidecarToken: env.GEPA_SIDECAR_TOKEN }),
  }
}
