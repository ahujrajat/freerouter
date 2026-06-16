import { describe, it, expect } from 'vitest'
import { LibraryPricingFetcher } from '../src/pricing/pricing-fetcher.js'
import type { PricingSource } from 'finrouter'

function fakeSource(manifest: Record<string, unknown>): PricingSource {
  return { fetch: async () => manifest as never }
}

describe('LibraryPricingFetcher', () => {
  it('fetches the named source and returns the manifest', async () => {
    const f = new LibraryPricingFetcher({
      litellm: () => fakeSource({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } }),
      openrouter: () => fakeSource({}),
    })
    expect(await f.fetch('litellm')).toEqual({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } })
  })

  it('throws on an unknown source name', async () => {
    const f = new LibraryPricingFetcher({})
    await expect(f.fetch('nope')).rejects.toThrow(/unknown pricing source/i)
  })
})
