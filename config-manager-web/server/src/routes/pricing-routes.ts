import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore } from '../store/config-store.js'
import type { SessionUser, Environment } from '../types.js'

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerPricingRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, pricingFetcher } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  app.get('/api/env/:id/pricing-fetch', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env: Environment | undefined = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) === undefined) return reply.code(403).send({ error: 'forbidden' })
    const source = (req.query as { source?: string }).source ?? 'litellm'
    let manifest
    try { manifest = await pricingFetcher.fetch(source) }
    catch (err) { return reply.code(502).send({ error: (err as Error).message }) }
    // Filter to providers enabled in this environment's config.
    const cfg = new JsonFileStore<{ providers?: Record<string, { enabled?: boolean }> }>(env.paths.config).read().data
    const enabled = new Set(Object.entries(cfg.providers ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k))
    const filtered = enabled.size === 0 ? manifest
      : Object.fromEntries(Object.entries(manifest).filter(([provider]) => enabled.has(provider)))
    return reply.send(filtered)
  })
}
