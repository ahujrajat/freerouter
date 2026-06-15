import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ByokSection } from '../src/sections/ByokSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('ByokSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing keys showing backend + last4 (no secret field shown for existing)', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ provider: 'openai', backend: 'local', isSet: true, last4: '7890' }]), { status: 200 })])
    render(<ByokSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('openai')).toBeInTheDocument()
    expect(screen.getByText(/7890/)).toBeInTheDocument()
  })

  it('sets a local key via the modal (POSTs backend + secret, never GETs it back)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    mockFetchSequence([
      () => new Response(JSON.stringify([]), { status: 200 }),                       // initial list
      (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ provider: 'openai', backend: 'local', isSet: true, last4: '0001' }), { status: 200 }) }, // POST
      () => new Response(JSON.stringify([{ provider: 'openai', backend: 'local', isSet: true, last4: '0001' }]), { status: 200 }), // reload list
    ])
    render(<ByokSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /set key/i }))
    await userEvent.type(screen.getByLabelText('Provider'), 'openai')
    await userEvent.type(screen.getByLabelText('Secret'), 'sk-xxxx0001')
    await userEvent.click(screen.getByRole('button', { name: /^save key$/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toBe('/api/env/dev/byok/openai')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ backend: 'local', secret: 'sk-xxxx0001' })
  })

  it('hides Set key for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([]), { status: 200 })])
    render(<ByokSection envId="dev" canWrite={false} />)
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull())
    expect(screen.queryByRole('button', { name: /set key/i })).toBeNull()
  })
})
