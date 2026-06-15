import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EnvVarsSection } from '../src/sections/EnvVarsSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('EnvVarsSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads env vars from the env resource and saves an added pair', async () => {
    const calls: RequestInit[] = []
    const urls: string[] = []
    mockFetchSequence([
      (u) => { urls.push(u); return new Response(JSON.stringify({ data: { EXISTING: 'x' }, version: 'v1' }), { status: 200 }) },
      (u, i) => { urls.push(u); calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<EnvVarsSection envId="dev" canWrite={true} />)
    expect((await screen.findByDisplayValue('EXISTING')).tagName).toBe('INPUT')
    await userEvent.click(screen.getByRole('button', { name: /add variable/i }))
    const keyInputs = screen.getAllByLabelText(/var name/i)
    await userEvent.type(keyInputs[keyInputs.length - 1]!, 'NEW_KEY')
    const valInputs = screen.getAllByLabelText(/var value/i)
    await userEvent.type(valInputs[valInputs.length - 1]!, 'newval')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(urls[0]).toContain('/api/env/dev/env')
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data).toMatchObject({ EXISTING: 'x', NEW_KEY: 'newval' })
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<EnvVarsSection envId="dev" canWrite={false} />)
    await screen.findByRole('button', { name: /save/i })
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('multi-select delete: select one row then delete selected then save omits deleted key', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { FOO: 'foo', BAR: 'bar' }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<EnvVarsSection envId="dev" canWrite={true} />)
    await screen.findByDisplayValue('FOO')
    await userEvent.click(screen.getByLabelText(/select row 0/i))
    await userEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data).not.toHaveProperty('FOO')
    expect(body.data).toMatchObject({ BAR: 'bar' })
  })
})
