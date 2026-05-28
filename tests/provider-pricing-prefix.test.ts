import { describe, it, expect } from 'vitest'
import { GoogleProvider } from '../src/providers/google.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'

/**
 * Regression: `pricing(model)` previously did `Object.keys(PRICING).find(k => model.startsWith(k))`,
 * which matched the first key in insertion order whose prefix fit. That meant
 * `pricing('gemini-2.0-flash-lite')` returned the parent `gemini-2.0-flash`
 * pricing (0.10) instead of lite's actual 0.075 — and downstream the cost
 * router fell through to a more expensive sibling. Fix: prefer exact match,
 * then longest-prefix.
 */

describe('provider pricing — exact + longest-prefix matching', () => {
  it('GoogleProvider returns the LITE price for gemini-2.0-flash-lite (not the parent)', () => {
    const g = new GoogleProvider()
    expect(g.pricing('gemini-2.0-flash-lite').input).toBe(0.075)
    expect(g.pricing('gemini-2.0-flash').input).toBe(0.10)
    expect(g.pricing('gemini-2.5-flash').input).toBe(0.075)
    expect(g.pricing('gemini-2.5-pro').input).toBe(1.25)
  })

  it('GoogleProvider falls back to longest-prefix for suffixed variants', () => {
    const g = new GoogleProvider()
    // gemini-2.0-flash is the longest prefix that fits the experimental name.
    expect(g.pricing('gemini-2.0-flash-preview-experimental').input).toBe(0.10)
  })

  it('OpenAIProvider distinguishes gpt-4o-mini from gpt-4o', () => {
    const o = new OpenAIProvider()
    const miniInput = o.pricing('gpt-4o-mini').input
    const fullInput = o.pricing('gpt-4o').input
    expect(miniInput).toBeLessThan(fullInput)
  })

  it('AnthropicProvider returns distinct pricing for haiku vs sonnet', () => {
    const a = new AnthropicProvider()
    const haiku  = a.pricing('claude-3-haiku-20240307').input
    const sonnet = a.pricing('claude-3-5-sonnet-20241022').input
    expect(haiku).toBeLessThan(sonnet)
  })
})
