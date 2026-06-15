import { describe, it, expect, vi } from 'vitest'
import { VaultClient } from '../src/byok/clients/vault-client.js'

describe('VaultClient (KV v2 over HTTP)', () => {
  it('writeSecret PUTs the value to the data path with the token header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    const c = new VaultClient({ addr: 'https://vault:8200', token: 'tok', mount: 'secret', fetch: fetchMock })
    await c.writeSecret('fr/openai', 'sk-1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://vault:8200/v1/secret/data/fr/openai')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['X-Vault-Token']).toBe('tok')
    expect(JSON.parse(init!.body as string)).toEqual({ data: { value: 'sk-1' } })
  })

  it('secretExists returns true on 200, false on 404', async () => {
    const ok = new VaultClient({ addr: 'https://v', token: 't', mount: 'secret', fetch: vi.fn(async () => new Response('{}', { status: 200 })) })
    expect(await ok.secretExists('fr/x')).toBe(true)
    const missing = new VaultClient({ addr: 'https://v', token: 't', mount: 'secret', fetch: vi.fn(async () => new Response('', { status: 404 })) })
    expect(await missing.secretExists('fr/x')).toBe(false)
  })
})
