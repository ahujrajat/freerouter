import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProvidersSection } from '../src/sections/ProvidersSection.js'

const KNOWN = ['google', 'openai', 'anthropic', 'mistral', 'groq']

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](url, init)))
}

describe('ProvidersSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders a toggle per known provider reflecting enabled state', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: { providers: { google: { enabled: true } } }, version: 'v1' }), { status: 200 })])
    render(<ProvidersSection envId="dev" canWrite={true} />)
    for (const p of KNOWN) expect(await screen.findByLabelText(p)).toBeInTheDocument()
    expect((await screen.findByLabelText('google') as HTMLInputElement).checked).toBe(true)
    expect((await screen.findByLabelText('openai') as HTMLInputElement).checked).toBe(false)
  })

  it('saves the providers map preserving other config keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep-me', providers: { google: { enabled: true } } }, version: 'v1' }), { status: 200 }),
      (_u, init) => { calls.push(init!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<ProvidersSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByLabelText('openai'))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep-me')               // untouched key preserved
    expect(body.data.providers.openai.enabled).toBe(true)        // toggled on
    expect(body.data.providers.google.enabled).toBe(true)        // unchanged
  })
})
