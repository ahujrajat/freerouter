import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
  const c1 = cookieHeader(loginRes.cookies)
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: c1 } })
  return cookieHeader(cb.cookies)
}

describe('byok routes', () => {
  it('lists empty, sets a local key, then lists it with last4 (never the secret)', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()).toEqual([])
    const set = await app.inject({ method: 'POST', url: '/api/env/dev/byok/openai', headers: { cookie }, payload: { backend: 'local', secret: 'sk-test-9999' } })
    expect(set.statusCode).toBe(200)
    const list = (await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()
    expect(list).toEqual([{ provider: 'openai', backend: 'local', isSet: true, last4: '9999' }])
    expect(JSON.stringify(list)).not.toMatch(/sk-test|ciphertext/)
    await app.close()
  })

  it('sets an external (vault) key with a ref', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const set = await app.inject({ method: 'POST', url: '/api/env/dev/byok/anthropic', headers: { cookie }, payload: { backend: 'vault', secret: 'sk-ant-1234', ref: 'fr/anthropic' } })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ provider: 'anthropic', backend: 'vault', last4: '1234', ref: 'fr/anthropic' })
    await app.close()
  })

  it('deletes a key', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    await app.inject({ method: 'POST', url: '/api/env/dev/byok/openai', headers: { cookie }, payload: { backend: 'local', secret: 'sk-1' } })
    expect((await app.inject({ method: 'DELETE', url: '/api/env/dev/byok/openai', headers: { cookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok', headers: { cookie } })).json()).toEqual([])
    await app.close()
  })

  it('400 for an unconfigured backend; 422 for local without a secret', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    expect((await app.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie }, payload: { backend: 'gcp-secret-manager', secret: 's' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie }, payload: { backend: 'local' } })).statusCode).toBe(422)
    await app.close()
  })

  it('forbids a viewer from setting a key (403) and 401 unauthenticated', async () => {
    const viewer = await buildTestApp({ claims: { sub: 'v', name: 'V', groups: ['fr-viewers'] } })
    const vcookie = await login(viewer)
    expect((await viewer.inject({ method: 'POST', url: '/api/env/dev/byok/x', headers: { cookie: vcookie }, payload: { backend: 'local', secret: 's' } })).statusCode).toBe(403)
    await viewer.close()
    const app = await buildTestApp()
    expect((await app.inject({ method: 'GET', url: '/api/env/dev/byok' })).statusCode).toBe(401)
    await app.close()
  })
})
