import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionUser } from '../types.js'

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const { audit } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  app.get('/api/audit', async (req, reply) => {
    const limit = Number((req.query as { limit?: string }).limit ?? '100')
    return reply.send(audit.recent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100))
  })
}
