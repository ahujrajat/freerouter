import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RulesSection } from '../src/sections/RulesSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('RulesSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads rules from the rules resource and lists them', async () => {
    const urls: string[] = []
    mockFetchSequence([(u) => { urls.push(u); return new Response(JSON.stringify({ data: [{ id: 'pin1', match: {}, action: { type: 'pin', model: 'gpt-4o' } }], version: 'v1' }), { status: 200 }) }])
    render(<RulesSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('pin1')).toBeInTheDocument()
    expect(urls[0]).toContain('/api/env/dev/rules')
  })

  it('adds a block rule via the modal and saves', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: [], version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: [], version: 'v2' }), { status: 200 }) },
    ])
    render(<RulesSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add rule/i }))
    await userEvent.type(screen.getByLabelText('ID'), 'block-bad')
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'block')
    await userEvent.type(screen.getByLabelText(/reason/i), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data[0]).toMatchObject({ id: 'block-bad', action: { type: 'block', reason: 'nope' } })
  })
})
