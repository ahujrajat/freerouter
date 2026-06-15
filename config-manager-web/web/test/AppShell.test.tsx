import { it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppShell } from '../src/app/AppShell.js'

beforeEach(() => vi.restoreAllMocks())

it('shows all section nav items and switches to Rate Limit', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/env/dev/')) return new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })
    if (url.endsWith('/api/env')) return new Response(JSON.stringify([{ id: 'dev', label: 'Development', role: 'admin' }]), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
  render(<AppShell me={{ subject: 'u', name: 'Ada', groups: ['fr-admins'] }} />)
  for (const label of ['General', 'Providers', 'Rate Limit', 'Budgets', 'Rules', 'Pricing Overrides', 'Optimization', 'Env Vars', 'BYOK Keys', 'Candidates', 'Audit', 'Reporting']) {
    expect(await screen.findByRole('link', { name: label })).toBeInTheDocument()
  }
  await userEvent.click(screen.getByRole('link', { name: 'Rate Limit' }))
  expect(await screen.findByRole('heading', { name: 'Rate Limit' })).toBeInTheDocument()
})
