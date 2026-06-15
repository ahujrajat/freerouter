import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { JsonFileStore } from '../store/config-store.js'
import type { SessionUser, Environment } from '../types.js'

interface Candidate {
  fingerprint: string; simhash: string; model: string; status: string
  sampleClassSignature?: string; estPredictedSavingsUsd?: number
}
interface OptimizedEntry {
  fingerprint: string; simhash: string; template: string
  qualityScore: number; predictedSavingsUsd: number; targetModel: string; optimizedAt: number
}

const currentUser = (req: FastifyRequest): SessionUser | undefined => req.session.get('user') as SessionUser | undefined
const readArray = <T>(path: string): T[] => { const d = new JsonFileStore(path).read().data; return Array.isArray(d) ? d as T[] : [] }

export async function registerCandidatesRoutes(app: FastifyInstance): Promise<void> {
  const { environments, roles, audit, sidecar } = app.deps

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (currentUser(req) === undefined) return reply.code(401).send({ error: 'unauthenticated' })
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

  app.get('/api/env/:id/candidates', async (req, reply) => {
    const env = resolve(req, reply, false)
    if (env === undefined) return
    return reply.send(readArray<Candidate>(env.paths.candidates))
  })

  app.post('/api/env/:id/candidates/:fingerprint/optimize', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    if (sidecar === undefined) return reply.code(503).send({ error: 'no GEPA sidecar configured' })
    const fingerprint = decodeURIComponent((req.params as { fingerprint: string }).fingerprint)
    const candidates = readArray<Candidate>(env.paths.candidates)
    const cand = candidates.find(c => c.fingerprint === fingerprint)
    if (cand === undefined) return reply.code(404).send({ error: 'unknown candidate' })

    const body = req.body as { targetModel?: string }
    const targetModel = body?.targetModel ?? cand.model
    let result
    try {
      result = await sidecar.optimize({
        classSignature: cand.sampleClassSignature ?? cand.fingerprint,
        targetModel,
        fallbackModel: cand.model,
        sample: { messages: [{ role: 'user', content: '' }], model: cand.model },
      })
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message })
    }

    // Write optimized store (array; upsert by fingerprint).
    const store = new JsonFileStore<OptimizedEntry[]>(env.paths.optimizedStore)
    const existing = readArray<OptimizedEntry>(env.paths.optimizedStore)
    const entry: OptimizedEntry = {
      fingerprint: cand.fingerprint, simhash: cand.simhash, template: result.template,
      qualityScore: result.qualityScore, predictedSavingsUsd: result.predictedSavingsUsd,
      targetModel, optimizedAt: Date.now(),
    }
    const merged = [...existing.filter(e => e.fingerprint !== cand.fingerprint), entry]
    store.write(merged, store.read().version)

    // Flip candidate status to 'optimized' and persist the candidates file.
    cand.status = 'optimized'
    const candStore = new JsonFileStore<Candidate[]>(env.paths.candidates)
    candStore.write(candidates, candStore.read().version)

    audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'candidate:optimize', target: `candidate:${fingerprint}`, description: `Optimized candidate ${fingerprint} → ${targetModel}` })
    return reply.send(cand)
  })

  app.delete('/api/env/:id/candidates/:fingerprint', async (req, reply) => {
    const env = resolve(req, reply, true)
    if (env === undefined) return
    const fingerprint = decodeURIComponent((req.params as { fingerprint: string }).fingerprint)
    const store = new JsonFileStore<Candidate[]>(env.paths.candidates)
    const candidates = readArray<Candidate>(env.paths.candidates)
    const filtered = candidates.filter(c => c.fingerprint !== fingerprint)
    if (filtered.length !== candidates.length) {
      store.write(filtered, store.read().version)
      audit.record({ subject: currentUser(req)!.subject, environment: (req.params as { id: string }).id, action: 'candidate:delete', target: `candidate:${fingerprint}`, description: `Deleted candidate ${fingerprint}` })
    }
    return reply.send({ ok: true })
  })
}
