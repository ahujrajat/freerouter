import { describe, it, expect } from 'vitest'
import type { OidcProvider, AuthRequest, Claims } from '../src/auth/oidc.js'

class FakeOidc implements OidcProvider {
  authUrl(req: AuthRequest): string {
    return `https://idp/auth?state=${req.state}&nonce=${req.nonce}&redirect_uri=${encodeURIComponent(req.redirectUri)}`
  }
  async exchange(): Promise<Claims> {
    return { sub: 'user-1', name: 'Ada', groups: ['fin-admins'] }
  }
}

describe('OidcProvider contract', () => {
  it('produces an auth URL carrying state, nonce, redirect', () => {
    const p: OidcProvider = new FakeOidc()
    const url = p.authUrl({ state: 's1', nonce: 'n1', redirectUri: 'https://app/cb' })
    expect(url).toContain('state=s1')
    expect(url).toContain('nonce=n1')
    expect(url).toContain(encodeURIComponent('https://app/cb'))
  })

  it('exchange returns normalized claims', async () => {
    const p: OidcProvider = new FakeOidc()
    const claims = await p.exchange({ callbackUrl: 'https://app/cb?code=x&state=s1', state: 's1', nonce: 'n1' })
    expect(claims.sub).toBe('user-1')
    expect(claims.groups).toContain('fin-admins')
  })
})
