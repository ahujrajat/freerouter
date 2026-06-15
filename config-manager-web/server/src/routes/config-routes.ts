import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore, StaleVersionError } from '../store/config-store.js'
import { validateConfigPayload, validateRulesPayload } from '../validation.js'
import { EnvFileStore } from '../store/env-file-store.js'
import type { SessionUser, Role, Environment } from '../types.js'

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
        description: 'Updated configuration',
        beforeHash: before.version, afterHash: next.version,
      })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })

  // Resolve env + role, or send the appropriate error. Returns the Environment on success.
  function resolveEnv(req: FastifyRequest, reply: FastifyReply, needWrite: boolean): Environment | undefined {
    const user = currentUser(req)!
    const id = (req.params as { id: string }).id
    const env = environments.get(id)
    if (env === undefined) { reply.code(404).send({ error: 'unknown environment' }); return undefined }
    const role = roles.roleFor(user.groups, id)
    if (role === undefined) { reply.code(403).send({ error: 'forbidden' }); return undefined }
    if (needWrite && role !== 'admin') { reply.code(403).send({ error: 'forbidden' }); return undefined }
    return env
  }

  // ── rules resource (separate JSON file) ──
  // When the rules file is absent JsonFileStore returns {}, but callers expect [].
  // Normalise: treat a non-array result (absent file) as an empty array.
  function readRules(path: string): { data: unknown[]; version: string } {
    const { data, version } = new JsonFileStore(path).read()
    return { data: Array.isArray(data) ? data as unknown[] : [], version }
  }

  app.get('/api/env/:id/rules', async (req, reply) => {
    const env = resolveEnv(req, reply, false)
    if (env === undefined) return
    return reply.send(readRules(env.paths.rules))
  })

  app.put('/api/env/:id/rules', async (req, reply) => {
    const env = resolveEnv(req, reply, true)
    if (env === undefined) return
    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })
    const validation = validateRulesPayload(body.data)
    if (!validation.ok) return reply.code(422).send({ error: 'invalid rules', messages: validation.messages })
    const store = new JsonFileStore<object>(env.paths.rules)
    const before = readRules(env.paths.rules)
    try {
      const next = store.write(body.data as object, body.version)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'rules:save', target: 'rules', description: `Saved rules (${(body.data as unknown[]).length} rule(s))`, beforeHash: before.version, afterHash: next.version })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })

  // ── env-vars resource (.env file) ──
  app.get('/api/env/:id/env', async (req, reply) => {
    const env = resolveEnv(req, reply, false)
    if (env === undefined) return
    return reply.send(new EnvFileStore(env.paths.env).read())
  })

  app.put('/api/env/:id/env', async (req, reply) => {
    const env = resolveEnv(req, reply, true)
    if (env === undefined) return
    const body = req.body as { data?: unknown; version?: unknown }
    if (typeof body?.version !== 'string') return reply.code(400).send({ error: 'missing version' })
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)
        || !Object.values(body.data as Record<string, unknown>).every(v => typeof v === 'string')) {
      return reply.code(422).send({ error: 'invalid env', messages: ['env must be an object of string values'] })
    }
    const store = new EnvFileStore(env.paths.env)
    const before = store.read()
    try {
      const next = store.write(body.data as Record<string, string>, body.version)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'env:save', target: 'env', description: `Saved environment variables (${Object.keys(body.data as Record<string, string>).length} key(s))`, beforeHash: before.version, afterHash: next.version })
      return reply.send(next)
    } catch (err) {
      if (err instanceof StaleVersionError) return reply.code(409).send({ error: 'version conflict' })
      throw err
    }
  })
}
