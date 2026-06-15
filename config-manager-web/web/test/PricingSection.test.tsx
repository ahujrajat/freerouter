import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PricingSection } from '../src/sections/PricingSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('PricingSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing overrides', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: { pricingOverrides: { 'gpt-4o': { input: 2.5, output: 10 } } }, version: 'v1' }), { status: 200 })])
    render(<PricingSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument()
  })

  it('adds an override via modal and saves preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', pricingOverrides: {} }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<PricingSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add override/i }))
    await userEvent.type(screen.getByLabelText('Model ID'), 'gpt-4o')
    await userEvent.type(screen.getByLabelText('Input $/1M'), '2.5')
    await userEvent.type(screen.getByLabelText('Output $/1M'), '10')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.pricingOverrides['gpt-4o']).toMatchObject({ input: 2.5, output: 10 })
  })

  it('fetches pricing from a source and merges a selected model into overrides', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { pricingOverrides: {} }, version: 'v1' }), { status: 200 }), // initial config load
      (url) => { calls.push({ url }); return new Response(JSON.stringify({ openai: { 'gpt-4o': { input: 2.5, output: 10 } } }), { status: 200 }) }, // pricing-fetch
      (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) }, // save
    ])
    render(<PricingSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /fetch from source/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^fetch$/i }))
    // select the fetched model + apply
    await userEvent.click(await screen.findByLabelText('gpt-4o'))
    await userEvent.click(screen.getByRole('button', { name: /apply selected/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls.some(c => c.url.includes('/pricing-fetch'))).toBe(true))
    const saveCall = calls.find(c => c.init?.method === 'PUT')!
    expect(JSON.parse(saveCall.init!.body as string).data.pricingOverrides['gpt-4o']).toMatchObject({ input: 2.5, output: 10 })
  })
})
