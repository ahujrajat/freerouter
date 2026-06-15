import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportingSection } from '../src/sections/ReportingSection.js'
import type { SpendReport } from '../src/types.js'

const REPORT: SpendReport = {
  configured: true,
  totals: { costUsd: 0.17, requests: 6, tokens: 9150 },
  range: { from: 1, to: 2 },
  burnRateUsdPerDay: 0.04,
  projectedMonthlyUsd: 1.2,
  byProvider: [{ key: 'openai', costUsd: 0.1, requests: 4, tokens: 5000 }],
  byModel: [],
  byUser: [],
  byTeam: [],
  byDepartment: [],
}

describe('ReportingSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders totals and a provider breakdown row from a mocked report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(REPORT), { status: 200 })))
    render(<ReportingSection envId="dev" canWrite={false} />)
    // totals — 0.17 < 1 so money() uses 4 decimal places
    expect(await screen.findByText('$0.1700')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
    expect(screen.getByText('9,150')).toBeInTheDocument()
    // burn / projection
    expect(screen.getByText('$0.0400')).toBeInTheDocument()
    expect(screen.getByText('$1.20')).toBeInTheDocument()
    // provider breakdown row
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('$0.1000')).toBeInTheDocument()
  })

  it('changing Window to "Last 30 days" triggers a fetch containing ?days=30', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      return new Response(JSON.stringify(REPORT), { status: 200 })
    }))
    render(<ReportingSection envId="dev" canWrite={false} />)
    await screen.findByText('$0.1700')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Window' }), '30')
    // wait for the re-fetch
    await screen.findByText('$0.1700')
    expect(urls.some(u => u.includes('?days=30'))).toBe(true)
  })

  it('shows "No spend data source is configured" note when configured:false', async () => {
    const unconfigured: SpendReport = {
      ...REPORT,
      configured: false,
      totals: { costUsd: 0, requests: 0, tokens: 0 },
      byProvider: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(unconfigured), { status: 200 })))
    render(<ReportingSection envId="dev" canWrite={false} />)
    expect(await screen.findByText(/No spend data source is configured/i)).toBeInTheDocument()
    expect(screen.queryByText('Total spend')).not.toBeInTheDocument()
  })
})
