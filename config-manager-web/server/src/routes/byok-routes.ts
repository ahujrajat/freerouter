import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { ByokStore } from '../byok/byok-store.js'
import type { BackendName } from '../byok/types.js'
import type { SessionUser, Environment } from '../types.js'

const BACKENDS: BackendName[] = ['local', 'vault', 'aws-secrets-manager', 'azure-key-vault', 'gcp-secret-manager']
const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined

export async function registerByokRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit, keyBackends } = app.deps

  // Require an authenticated session for everything under /api (byok routes plugin scope).
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }
  })

  function resolve(req: FastifyRequest, reply: FastifyReply, needWrite: boolean): Environment | undefined {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) { reply.code(404).send({ error: 'unknown environment' }); return undefined }
    const role = roles.roleFor(user.groups, id)
    if (role === undefined) { reply.code(403).send({ error: 'forbidden' }); return undefined }
    if (needWrite && role !== 'admin') { reply.code(403).send({ error: 'forbidden' }); return undefined }
    return env
  }

  app.get('/api/env/:id/byok', async (req, reply) => {
    const env = resolve(req, reply, false)
    if (env === undefined) return
    return reply.send(new ByokStore(env.paths.byok).list())
  })

  app.post('/api/env/:id/byok/:provider', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    const provider = (req.params as { provider: string }).provider
    const body = req.body as { backend?: string; secret?: string; ref?: string }
    if (typeof body?.backend !== 'string' || !BACKENDS.includes(body.backend as BackendName)) {
      return reply.code(400).send({ error: 'invalid or unknown backend' })
    }
    let backend
    try { backend = keyBackends.get(body.backend as BackendName) }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }) }
    try {
      const record = await backend.materialize(body.secret, { provider, ...(body.ref !== undefined && { ref: body.ref }) })
      const store = new ByokStore(env.paths.byok)
      store.upsert(provider, record)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'byok:set', target: `byok:${provider}` })
      const view = store.list().find(e => e.provider === provider)
      return reply.send(view)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/env/:id/byok/:provider', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    const provider = (req.params as { provider: string }).provider
    const store = new ByokStore(env.paths.byok)
    const record = store.getRaw(provider)
    if (record !== undefined) {
      try { await keyBackends.get(record.backend).destroy(record) } catch { /* best-effort external cleanup */ }
      store.remove(provider)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'byok:delete', target: `byok:${provider}` })
    }
    return reply.send({ ok: true })
  })
}
