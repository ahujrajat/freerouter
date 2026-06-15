import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionUser, Environment } from '../types.js'
import { readSpendRecords, buildReport } from '../reporting/spend-report.js'

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
  })

  function resolve(req: FastifyRequest, reply: FastifyReply): Environment | undefined {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) { reply.code(404).send({ error: 'unknown environment' }); return undefined }
    const role = roles.roleFor(user.groups, id)
    if (role === undefined) { reply.code(403).send({ error: 'forbidden' }); return undefined }
    return env
  }

  app.get('/api/env/:id/report', async (req, reply) => {
    const env = resolve(req, reply)
    if (env === undefined) return

    if (env.paths.spend === undefined) {
      return reply.send(buildReport([], false))
    }

    let records = readSpendRecords(env.paths.spend)

    const daysParam = (req.query as { days?: string }).days
    const days = daysParam !== undefined ? Number(daysParam) : NaN
    if (!isNaN(days) && days > 0) {
      const cutoff = Date.now() - days * 86_400_000
      records = records.filter(r => typeof r.timestamp === 'number' && r.timestamp >= cutoff)
    }

    return reply.send(buildReport(records, true))
  })
}
