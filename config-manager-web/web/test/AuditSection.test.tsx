import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuditSection } from '../src/sections/AuditSection.js'

describe('AuditSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders recent audit records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { timestamp: 1749470000000, subject: 'alice', environment: 'prod', action: 'config:save', target: 'config' },
    ]), { status: 200 })))
    render(<AuditSection envId="dev" canWrite={false} />)
    expect(await screen.findByText('config:save')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('prod')).toBeInTheDocument()
  })

  it('fetches from the global audit endpoint', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return new Response('[]', { status: 200 }) }))
    render(<AuditSection envId="dev" canWrite={false} />)
    await screen.findByText(/no audit/i)
    expect(urls[0]).toContain('/api/audit')
  })
})
