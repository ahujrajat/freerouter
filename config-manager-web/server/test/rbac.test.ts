import { describe, it, expect } from 'vitest'
import { RoleResolver, type RoleMapping } from '../src/auth/rbac.js'

const mapping: RoleMapping = {
  defaults: { 'fr-admins': 'admin', 'fr-viewers': 'viewer' },
  perEnvironment: {
    prod: { 'fr-admins': 'viewer', 'fr-prod-admins': 'admin' },
  },
}

describe('RoleResolver', () => {
  const resolver = new RoleResolver(mapping)

  it('resolves the highest default role from a user\'s groups', () => {
    expect(resolver.roleFor(['fr-viewers'], 'dev')).toBe('viewer')
    expect(resolver.roleFor(['fr-admins'], 'dev')).toBe('admin')
  })

  it('applies per-environment overrides', () => {
    expect(resolver.roleFor(['fr-admins'], 'prod')).toBe('viewer')
    expect(resolver.roleFor(['fr-prod-admins'], 'prod')).toBe('admin')
    expect(resolver.roleFor(['fr-prod-admins'], 'dev')).toBeUndefined()
  })

  it('returns undefined when no group maps to a role', () => {
    expect(resolver.roleFor(['random'], 'dev')).toBeUndefined()
  })

  it('admin wins when multiple groups grant different roles', () => {
    expect(resolver.roleFor(['fr-viewers', 'fr-admins'], 'dev')).toBe('admin')
  })
})
