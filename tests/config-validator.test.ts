import { describe, it, expect } from 'vitest'
import { validateConfig } from '../src/config-validator.js'

describe('validateConfig — known-key coverage', () => {
  it('emits no "possible typo" warnings for documented RouterConfig keys', () => {
    const cfg = {
      spendPersistence: {}, telemetryExport: {}, shadowRouter: {},
      promptOptimization: {}, autoOptimization: { enabled: true },
      costOptimization: {}, pricingRefresh: {}, rules: {}, rulesRefresh: {},
    }
    const result = validateConfig(cfg)
    expect(result.valid).toBe(true)
    expect(result.warnings.filter(w => /possible typo/.test(w))).toEqual([])
  })

  it('still flags a genuinely unknown key as a warning', () => {
    const result = validateConfig({ totallyBogusKey: 1 })
    expect(result.warnings.some(w => /totallyBogusKey/.test(w))).toBe(true)
  })
})
