import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GeneralSection } from '../src/sections/GeneralSection.js'

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](url, init)))
}

describe('GeneralSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads current config and saves edits with the version', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'old' }, version: 'v1' }), { status: 200 }),
      (_u, init) => { calls.push(init!); return new Response(JSON.stringify({ data: { defaultModel: 'new' }, version: 'v2' }), { status: 200 }) },
    ])
    render(<GeneralSection envId="dev" canWrite={true} />)
    const input = await screen.findByLabelText('Default model')
    expect((input as HTMLInputElement).value).toBe('old')
    await userEvent.clear(input)
    await userEvent.type(input, 'new')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ version: 'v1', data: { defaultModel: 'new' } })
  })

  it('shows a conflict banner on 409', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 }),
      () => new Response(JSON.stringify({ error: 'version conflict' }), { status: 409 }),
    ])
    render(<GeneralSection envId="dev" canWrite={true} />)
    await screen.findByLabelText('Default model')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on the server/i)
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<GeneralSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Default model')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
