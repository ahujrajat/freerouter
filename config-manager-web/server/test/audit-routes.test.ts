import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('audit route', () => {
  it('returns recent audit records after a mutation', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { defaultModel: 'm' }, version: read.json().version } })
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const records = res.json()
    expect(Array.isArray(records)).toBe(true)
    expect(records[0]).toMatchObject({ action: 'config:save', environment: 'dev' })
    expect(typeof records[0].description).toBe('string')
    expect(records[0].description).toMatch(/configuration/i)
    await app.close()
  })

  it('401 unauthenticated', async () => {
    const app = await buildTestApp()
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401)
    await app.close()
  })
})
