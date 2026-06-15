import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('pricing-fetch route', () => {
  it('returns the fetched manifest filtered to configured providers', async () => {
    const app = await buildTestApp()
    const cookie = await login(app)
    // Configure the dev env so only google is enabled.
    const read = await app.inject({ method: 'GET', url: '/api/env/dev/config', headers: { cookie } })
    await app.inject({ method: 'PUT', url: '/api/env/dev/config', headers: { cookie }, payload: { data: { providers: { google: { enabled: true }, openai: { enabled: false } } }, version: read.json().version } })
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/pricing-fetch?source=litellm', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const manifest = res.json()
    expect(manifest.google).toBeDefined()
    expect(manifest.openai).toBeUndefined()   // filtered out (not enabled)
    await app.close()
  })

  it('401 unauthenticated', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/pricing-fetch?source=litellm' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
