import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CandidatesSection } from '../src/sections/CandidatesSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('CandidatesSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists candidates with status and savings', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'observed' }]), { status: 200 })])
    render(<CandidatesSection envId="dev" canWrite={true} />)
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument()
    expect(screen.getByText(/observed/)).toBeInTheDocument()
  })

  it('optimizes a candidate: POSTs to the optimize endpoint and reloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    mockFetchSequence([
      () => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'observed' }]), { status: 200 }),
      (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: 'optimized' }), { status: 200 }) },
      () => new Response(JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'optimized' }]), { status: 200 }),
    ])
    render(<CandidatesSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByRole('button', { name: /optimize/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toContain('/api/env/dev/candidates/')
    expect(calls[0]!.url).toContain('/optimize')
    expect(calls[0]!.init!.method).toBe('POST')
  })

  it('hides Optimize for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify([{ fingerprint: 'x', model: 'm', count: 1, estPredictedSavingsUsd: 0, status: 'observed' }]), { status: 200 })])
    render(<CandidatesSection envId="dev" canWrite={false} />)
    await screen.findByText('m')
    expect(screen.queryByRole('button', { name: /optimize/i })).toBeNull()
  })

  it('multi-select delete: select all and delete calls DELETE for each fingerprint then reloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fp1 = 'eh:gpt-4o:ab'
    const fp2 = 'eh:claude-3:cd'
    mockFetchSequence([
      () => new Response(JSON.stringify([
        { fingerprint: fp1, model: 'gpt-4o', count: 5, estPredictedSavingsUsd: 0.05, status: 'observed' },
        { fingerprint: fp2, model: 'claude-3', count: 3, estPredictedSavingsUsd: 0.02, status: 'observed' },
      ]), { status: 200 }),
      (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) },
      (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) },
      () => new Response(JSON.stringify([]), { status: 200 }),
    ])
    render(<CandidatesSection envId="dev" canWrite={true} />)
    await screen.findByText('gpt-4o')
    await userEvent.click(screen.getByLabelText(/select all/i))
    await userEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    await waitFor(() => expect(calls).toHaveLength(2))
    const deleteCalls = calls.filter(c => c.init?.method === 'DELETE')
    expect(deleteCalls).toHaveLength(2)
    const urls = deleteCalls.map(c => c.url)
    expect(urls.some(u => u.includes(encodeURIComponent(fp1)))).toBe(true)
    expect(urls.some(u => u.includes(encodeURIComponent(fp2)))).toBe(true)
  })
})
