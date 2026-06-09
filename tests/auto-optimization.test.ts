import { describe, it, expect } from 'vitest'
import { simhash64, hammingDistance } from '../src/optimization/simhash.js'

describe('simhash64', () => {
  it('is stable across whitespace and case differences', () => {
    const a = simhash64('Refactor this function to be async')
    const b = simhash64('refactor   this FUNCTION to be async')
    expect(a).toBe(b)
  })

  it('produces a 16-char zero-padded hex string', () => {
    const h = simhash64('hello world')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns a stable sentinel for empty input', () => {
    expect(simhash64('   ')).toBe('0000000000000000')
  })
})

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0)
  })

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000003')).toBe(2)
  })

  it('near-duplicate text is within a small distance', () => {
    const a = simhash64('summarize the quarterly earnings report for acme corp')
    const b = simhash64('summarize the quarterly earnings report for acme corporation')
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(8)
  })
})
