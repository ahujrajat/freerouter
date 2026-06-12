import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore, StaleVersionError } from '../store/config-store.js'
import { validateConfigPayload } from '../validation.js'
import type { SessionUser, Role } from '../types.js'

function currentUser(req: FastifyRequest): SessionUser | undefined {
  return req.session.get('user')
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit } = app.deps

  // Require an authenticated session for everything under /api.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }
  })

  app.get('/api/env', async (req, reply) => {
    const user = currentUser(req)!
    const visible = environments.list()
      .filter(e => roles.roleFor(user.groups, e.id) !== undefined)
      .map(e => ({ id: e.id, label: e.label, role: roles.roleFor(user.groups, e.id) as Role }))
    return reply.send(visible)
  })

  app.get('/api/env/:id/config', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) === undefined) return reply.code(403).send({ error: 'forbidden' })
    const store = new JsonFileStore(env.paths.config)
    return reply.send(store.read())
  })

  app.put('/api/env/:id/config', async (req, reply) => {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) return reply.code(404).send({ error: 'unknown environment' })
    if (roles.roleFor(user.groups, id) !== 'admin') return reply.code(403).send({ error: 'forbidden' })

    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })

    const validation = validateConfigPayload(body.data)
    if (!validation.ok) return reply.code(422).send({ error: 'invalid config', messages: validation.messages })

    const store = new JsonFileStore(env.paths.config)
    const before = store.read()
    try {
      const next = store.write(body.data as Record<string, unknown>, body.version)
      audit.record({
        subject: user.subject, environment: id, action: 'config:save', target: 'config',
        beforeHash: before.version, afterHash: next.version,
      })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })
}
