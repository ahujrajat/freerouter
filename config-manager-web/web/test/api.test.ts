import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, ApiError } from '../src/api.js'

describe('api client', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('GET returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })))
    expect(await api.get('/api/env')).toEqual({ ok: 1 })
  })

  it('throws ApiError with status on 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'version conflict' }), { status: 409 })))
    await expect(api.put('/api/env/dev/config', {})).rejects.toMatchObject({ status: 409 })
    await expect(api.put('/api/env/dev/config', {})).rejects.toBeInstanceOf(ApiError)
  })

  it('throws ApiError carrying validation messages on 422', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: ['bad: x'] }), { status: 422 })))
    await expect(api.put('/api/env/dev/config', {})).rejects.toMatchObject({ status: 422, messages: ['bad: x'] })
  })
})
