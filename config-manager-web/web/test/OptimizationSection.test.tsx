import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OptimizationSection } from '../src/sections/OptimizationSection.js'

function mockFetchSequence(handlers: Array<(u: string, i?: RequestInit) => Response>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handlers[Math.min(i++, handlers.length - 1)](u, init)))
}

describe('OptimizationSection', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('toggles autoOptimization.enabled and saves preserving other keys', async () => {
    const calls: RequestInit[] = []
    mockFetchSequence([
      () => new Response(JSON.stringify({ data: { defaultModel: 'keep', autoOptimization: { enabled: false, targetModel: 'm' } }, version: 'v1' }), { status: 200 }),
      (_u, i) => { calls.push(i!); return new Response(JSON.stringify({ data: {}, version: 'v2' }), { status: 200 }) },
    ])
    render(<OptimizationSection envId="dev" canWrite={true} />)
    await userEvent.click(await screen.findByLabelText('Enable auto-optimization'))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = JSON.parse(calls[0]!.body as string)
    expect(body.data.defaultModel).toBe('keep')
    expect(body.data.autoOptimization.enabled).toBe(true)
    expect(body.data.autoOptimization.targetModel).toBe('m')   // existing sub-key preserved
  })

  it('disables save for viewers', async () => {
    mockFetchSequence([() => new Response(JSON.stringify({ data: {}, version: 'v1' }), { status: 200 })])
    render(<OptimizationSection envId="dev" canWrite={false} />)
    await screen.findByLabelText('Enable auto-optimization')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
