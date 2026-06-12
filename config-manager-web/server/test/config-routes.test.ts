import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
  const c1 = cookieHeader(loginRes.cookies)
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: c1 } })
  return cookieHeader(cb.cookies)
}

describe('config routes', () => {
  it('lists environments for an authenticated user', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/api/env', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((e: { id: string }) => e.id)).toContain('dev')
    await app.close()
  })

  it('reads an empty config with a version, then writes it back', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/config', headers: { cookie },
      payload: { data: { defaultModel: 'gemini-2.5-flash' }, version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data).toMatchObject({ defaultModel: 'gemini-2.5-flash' })
  })

  it('rejects a stale write with 409', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'gpt-4o' }, version } })
    const stale = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'gemini' }, version } })
    expect(stale.statusCode).toBe(409)
    await app.close()
  })

  it('rejects an invalid config with 422', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { bogusKey: 1 }, version } })
    expect(res.statusCode).toBe(422)
    expect(JSON.stringify(res.json())).toMatch(/bogusKey/)
    await app.close()
  })

  it('forbids a viewer from writing (403)', async () => {
    const app = await buildTestApp({ claims: { sub: 'v1', name: 'Viewer', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'x' }, version } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('401 for unauthenticated config read', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/config' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('reads and writes the rules resource', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toEqual([])
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/rules', headers: { cookie },
      payload: { data: [{ id: 'r1', match: {}, action: { type: 'block', reason: 'x' } }], version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data[0].id).toBe('r1')
    await app.close()
  })

  it('rejects invalid rules with 422', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/rules', headers: { cookie }, payload: { data: [{ id: 'x' }], version } })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('reads and writes the env resource', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/env', headers: { cookie } })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toEqual({})
    const { version } = read.json()
    const write = await app.inject({
      method: 'PUT', url: '/api/env/dev/env', headers: { cookie },
      payload: { data: { GEMINI_API_KEY: 'abc' }, version },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json().data.GEMINI_API_KEY).toBe('abc')
    await app.close()
  })

  it('forbids a viewer from writing rules (403)', async () => {
    const app = await buildTestApp({ claims: { sub: 'v', name: 'V', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const { version } = (await app.inject({ method: 'GET', url: '/api/env/dev/rules', headers: { cookie } })).json()
    const res = await app.inject({ method: 'PUT', url: '/api/env/dev/rules', headers: { cookie }, payload: { data: [], version } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
