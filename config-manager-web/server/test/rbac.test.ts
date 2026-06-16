import { describe, it, expect } from 'vitest'
import { RoleResolver, type RoleMapping } from '../src/auth/rbac.js'

const mapping: RoleMapping = {
  defaults: { 'fin-admins': 'admin', 'fin-viewers': 'viewer' },
  perEnvironment: {
    prod: { 'fin-admins': 'viewer', 'fin-prod-admins': 'admin' },
  },
}

describe('RoleResolver', () => {
  const resolver = new RoleResolver(mapping)

  it('resolves the highest default role from a user\'s groups', () => {
    expect(resolver.roleFor(['fin-viewers'], 'dev')).toBe('viewer')
    expect(resolver.roleFor(['fin-admins'], 'dev')).toBe('admin')
  })

  it('applies per-environment overrides', () => {
    expect(resolver.roleFor(['fin-admins'], 'prod')).toBe('viewer')
    expect(resolver.roleFor(['fin-prod-admins'], 'prod')).toBe('admin')
    expect(resolver.roleFor(['fin-prod-admins'], 'dev')).toBeUndefined()
  })

  it('returns undefined when no group maps to a role', () => {
    expect(resolver.roleFor(['random'], 'dev')).toBeUndefined()
  })

  it('admin wins when multiple groups grant different roles', () => {
    expect(resolver.roleFor(['fin-viewers', 'fin-admins'], 'dev')).toBe('admin')
  })
})
