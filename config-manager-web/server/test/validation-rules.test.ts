import { describe, it, expect } from 'vitest'
import { validateRulesPayload } from '../src/validation.js'

describe('validateRulesPayload', () => {
  it('accepts a valid rules array', () => {
    const r = validateRulesPayload([
      { id: 'pin-pro', match: { metadata: { tier: 'premium' } }, action: { type: 'pin', model: 'gpt-4o' } },
      { id: 'block-x', match: { userId: 'bad' }, action: { type: 'block', reason: 'no' } },
    ])
    expect(r.ok).toBe(true)
  })

  it('requires an array', () => {
    expect(validateRulesPayload({} as unknown).ok).toBe(false)
  })

  it('flags a rule missing id/match/action', () => {
    const r = validateRulesPayload([{ id: 'x' }])
    expect(r.ok).toBe(false)
    expect(r.messages.join(' ')).toMatch(/match|action/)
  })

  it('flags an unknown action type', () => {
    const r = validateRulesPayload([{ id: 'x', match: {}, action: { type: 'nope' } }])
    expect(r.ok).toBe(false)
    expect(r.messages.join(' ')).toMatch(/action.*type|type/)
  })
})
