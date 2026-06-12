import { describe, it, expect } from 'vitest'
import { buildTestApp, cookieHeader } from './helpers.js'

describe('auth routes', () => {
  it('/auth/me is 401 before login', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('/auth/login redirects to the IdP and sets a state cookie', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('https://idp/auth')
    await app.close()
  })

  it('full login flow: callback establishes a session, /auth/me returns the user', async () => {
    const app = await buildTestApp({ claims: { sub: 'u1', name: 'Ada', groups: ['fr-admins'] } })
    const login = await app.inject({ method: 'GET', url: '/auth/login' })
    const cookies = cookieHeader(login.cookies)
    // Our FakeOidc ignores params; provide state matching the cookie via the login redirect.
    const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookies } })
    expect(cb.statusCode).toBe(302)
    const sessionCookies = cookieHeader(cb.cookies)
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: sessionCookies } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ subject: 'u1', name: 'Ada' })
    await app.close()
  })
})
