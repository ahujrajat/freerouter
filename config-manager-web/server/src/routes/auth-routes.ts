import type { FastifyInstance } from 'fastify'
import { newState, newNonce } from '../auth/oidc.js'
import type { SessionUser } from '../types.js'

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { oidc, redirectUri, afterLoginRedirect } = app.deps

  app.get('/auth/login', async (req, reply) => {
    const state = newState()
    const nonce = newNonce()
    req.session.set('oauth_state', state)
    req.session.set('oauth_nonce', nonce)
    return reply.redirect(oidc.authUrl({ state, nonce, redirectUri }))
  })

  app.get('/auth/callback', async (req, reply) => {
    const state = req.session.get('oauth_state')
    const nonce = req.session.get('oauth_nonce')
    if (state === undefined || nonce === undefined) {
      return reply.code(400).send({ error: 'missing auth state' })
    }
    const url = new URL(req.url, redirectUri)
    const claims = await oidc.exchange({ callbackUrl: url.toString(), state, nonce })
    const user: SessionUser = { subject: claims.sub, name: claims.name, groups: claims.groups }
    req.session.set('user', user)
    req.session.set('oauth_state', undefined)
    req.session.set('oauth_nonce', undefined)
    return reply.redirect(afterLoginRedirect)
  })

  app.get('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.redirect('/')
  })

  app.get('/auth/me', async (req, reply) => {
    const user = req.session.get('user')
    if (user === undefined) return reply.code(401).send({ error: 'unauthenticated' })
    return reply.send(user)
  })
}
