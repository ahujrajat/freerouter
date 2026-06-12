import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RateLimitSection } from '../src/sections/RateLimitSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('RateLimitSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads rateLimit and saves edits preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', rateLimit: { requestsPerMinute: 30 } }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<RateLimitSection envId="dev" canWrite={true} />)
    const rpm = await screen.findByLabelText('Requests per minute')
    expect((rpm as HTMLInputElement).value).toBe('30')
    await userEvent.clear(rpm)
    await userEvent.type(rpm, '60')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.rateLimit.requestsPerMinute).toBe(60)
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<RateLimitSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Requests per minute')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
