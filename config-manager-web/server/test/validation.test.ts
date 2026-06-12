import { describe, it, expect } from 'vitest'
import { validateConfigPayload } from '../src/validation.js'

describe('validateConfigPayload', () => {
  it('accepts a minimal valid config', () => {
    const result = validateConfigPayload({ defaultProvider: 'google', defaultModel: 'gemini-2.5-flash' })
    expect(result.ok).toBe(true)
  })

  it('flags unknown top-level keys', () => {
    const result = validateConfigPayload({ notAKey: true })
    expect(result.ok).toBe(false)
    expect(result.messages.join(' ')).toMatch(/notAKey/)
  })

  it('accepts a config using newer keys (costOptimization, autoOptimization)', () => {
    const result = validateConfigPayload({ costOptimization: { strategy: 'cheapest' }, autoOptimization: { enabled: true } })
    expect(result.ok).toBe(true)
  })
})
