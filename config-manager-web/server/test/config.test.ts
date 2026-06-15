import { describe, it, expect } from 'vitest'
import { loadServerConfig } from '../src/config.js'

describe('loadServerConfig', () => {
  const base = {
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback',
    SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/etc/fr/environments.json',
    AUDIT_LOG_FILE: '/var/log/fr-admin-audit.jsonl',
  }

  it('parses a complete environment', () => {
    const cfg = loadServerConfig(base)
    expect(cfg.oidc.issuer).toBe('https://idp.example.com')
    expect(cfg.oidc.groupsClaim).toBe('groups')   // default
    expect(cfg.port).toBe(7700)                     // default
  })

  it('throws when a required var is missing', () => {
    const rest = { ...base }
    delete (rest as Record<string, string | undefined>).OIDC_CLIENT_ID
    expect(() => loadServerConfig(rest)).toThrow(/OIDC_CLIENT_ID/)
  })

  it('throws when SESSION_SECRET is shorter than 32 chars', () => {
    expect(() => loadServerConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/)
  })
})

describe('loadServerConfig – BYOK', () => {
  const base = {
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback',
    SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/etc/fr/environments.json',
    AUDIT_LOG_FILE: '/var/log/fr-admin-audit.jsonl',
  }

  it('parses BYOK_MASTER_KEY when present', () => {
    const cfg = loadServerConfig({ ...base, BYOK_MASTER_KEY: 'my-master-key' })
    expect(cfg.byokMasterKey).toBe('my-master-key')
  })

  it('leaves byokMasterKey undefined when BYOK_MASTER_KEY is absent', () => {
    const cfg = loadServerConfig(base)
    expect(cfg.byokMasterKey).toBeUndefined()
  })
})

describe('loadServerConfig — GEPA sidecar', () => {
  const base = {
    OIDC_ISSUER: 'https://idp', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    OIDC_REDIRECT_URI: 'https://app/cb', SESSION_SECRET: 'x'.repeat(32),
    ENVIRONMENTS_FILE: '/e.json', AUDIT_LOG_FILE: '/a.jsonl',
  }
  it('parses GEPA_SIDECAR_URL and token when present', () => {
    const cfg = loadServerConfig({ ...base, GEPA_SIDECAR_URL: 'http://127.0.0.1:8765', GEPA_SIDECAR_TOKEN: 'tok' })
    expect(cfg.gepaSidecarUrl).toBe('http://127.0.0.1:8765')
    expect(cfg.gepaSidecarToken).toBe('tok')
  })
  it('leaves them undefined when absent', () => {
    const cfg = loadServerConfig(base)
    expect(cfg.gepaSidecarUrl).toBeUndefined()
    expect(cfg.gepaSidecarToken).toBeUndefined()
  })
})
