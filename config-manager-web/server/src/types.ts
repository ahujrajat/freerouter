export type Role = 'admin' | 'viewer'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
  groupsClaim: string
}

export interface ServerConfig {
  port: number
  sessionSecret: string
  oidc: OidcConfig
  environmentsFile: string
  auditLogFile: string
}

export interface SessionUser {
  subject: string
  name: string
  groups: string[]
}

export interface EnvironmentPaths {
  config: string
  rules: string
  env: string
  pricing: string
  optimizedStore: string
  candidates: string
}

export interface Environment {
  id: string
  label: string
  paths: EnvironmentPaths
}

/** A document read from disk plus the version that must be echoed on write. */
export interface VersionedDoc<T> {
  data: T
  version: string
}
