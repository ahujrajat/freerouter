import { describe, it, expect } from 'vitest'
import { KeyBackendRegistry } from '../src/byok/registry.js'
import { LocalKeyBackend } from '../src/byok/local-backend.js'

describe('KeyBackendRegistry', () => {
  it('resolves a registered backend by name', () => {
    const reg = new KeyBackendRegistry({ local: new LocalKeyBackend('a'.repeat(64)) })
    expect(reg.get('local').name).toBe('local')
    expect(reg.available()).toEqual(['local'])
  })
  it('throws a clear error for an unconfigured backend', () => {
    const reg = new KeyBackendRegistry({})
    expect(() => reg.get('vault')).toThrow(/not configured/i)
  })
})
