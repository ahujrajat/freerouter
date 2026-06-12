import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BudgetsSection } from '../src/sections/BudgetsSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}
const cfgRes = (budgets: unknown[], extra: object = {}) =>
  new Response(JSON.stringify({ data: { ...extra, budgets }, version: 'v1' }), { status: 200 })

describe('BudgetsSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists existing budgets', async () => {
    mockFetchSequence([() => cfgRes([{ id: 'org-monthly', scope: { type: 'org', orgId: 'o' }, window: 'monthly', maxSpendUsd: 5, onLimitReached: 'warn' }])])
    render(<BudgetsSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('org-monthly')).toBeInTheDocument()
  })

  it('adds a budget via the modal and saves, preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => cfgRes([], { defaultModel: 'keep' }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<BudgetsSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /add budget/i }))
    await userEvent.type(screen.getByLabelText('ID'), 'team-daily')
    await userEvent.type(screen.getByLabelText('Max spend (USD)'), '0.5')
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'daily')
    await userEvent.selectOptions(screen.getByLabelText('On limit reached'), 'warn')
    await userEvent.selectOptions(screen.getByLabelText('Scope type'), 'global')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.budgets[0]).toMatchObject({ id: 'team-daily', window: 'daily', maxSpendUsd: 0.5, onLimitReached: 'warn', scope: { type: 'global' } })
  })

  it('hides Add for viewers', async () => {
    mockFetchSequence([() => cfgRes([])])
    render(<BudgetsSection envId="dev" canWrite={false} />)
    await screen.findByRole('button', { name: /save/i })
    expect(screen.queryByRole('button', { name: /add budget/i })).toBeNull()
  })
})
