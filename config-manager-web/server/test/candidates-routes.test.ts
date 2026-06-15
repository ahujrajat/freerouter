import { describe, it, expect } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { buildTestApp, cookieHeader } from './helpers.js'

async function login(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const l = await app.inject({ method: 'GET', url: '/auth/login' })
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=test', headers: { cookie: cookieHeader(l.cookies) } })
  return cookieHeader(cb.cookies)
}

describe('candidates routes', () => {
  it('lists candidates from the env candidates file', async () => {
    const { app, dir } = await buildTestApp({ withDir: true })
    const cookie = await login(app)
    writeFileSync(`${dir}/cand.json`, JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 5, totalCostUsd: 0.2, lastSeen: 1, estPredictedSavingsUsd: 0.05, estBreakEvenReqs: 4, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }]))
    const res = await app.inject({ method: 'GET', url: '/api/env/dev/candidates', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0].fingerprint).toBe('eh:gpt-4o:ab')
    await app.close()
  })

  it('optimizes a candidate: calls sidecar, writes optimized store, flips status', async () => {
    const { app, dir } = await buildTestApp({ withDir: true })
    const cookie = await login(app)
    const cand = { fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 5, totalCostUsd: 0.2, lastSeen: 1, estPredictedSavingsUsd: 0.05, estBreakEvenReqs: 4, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }
    writeFileSync(`${dir}/cand.json`, JSON.stringify([cand]))
    const res = await app.inject({ method: 'POST', url: '/api/env/dev/candidates/eh:gpt-4o:ab/optimize', headers: { cookie }, payload: { targetModel: 'gpt-4o-mini' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('optimized')
    // optimized store written
    const opt = JSON.parse(readFileSync(`${dir}/opt.json`, 'utf-8'))
    expect(opt[0]).toMatchObject({ fingerprint: 'eh:gpt-4o:ab', template: 'OPTIMIZED for eh:gpt-4o:ab', targetModel: 'gpt-4o-mini' })
    await app.close()
  })

  it('forbids a viewer from optimizing (403)', async () => {
    const { app } = await buildTestApp({ withDir: true, claims: { sub: 'v', name: 'V', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const res = await app.inject({ method: 'POST', url: '/api/env/dev/candidates/x/optimize', headers: { cookie }, payload: {} })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('deletes a candidate and returns { ok: true }', async () => {
    const { app, dir } = await buildTestApp({ withDir: true })
    const cookie = await login(app)
    writeFileSync(`${dir}/cand.json`, JSON.stringify([{ fingerprint: 'eh:gpt-4o:ab', simhash: '00000000000000ab', model: 'gpt-4o', count: 5, totalCostUsd: 0.2, lastSeen: 1, estPredictedSavingsUsd: 0.05, estBreakEvenReqs: 4, sampleClassSignature: 'eh:gpt-4o:ab', status: 'observed' }]))
    const res = await app.inject({ method: 'DELETE', url: '/api/env/dev/candidates/eh:gpt-4o:ab', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    // candidate is gone from the file
    const remaining = JSON.parse(readFileSync(`${dir}/cand.json`, 'utf-8'))
    expect(remaining).toEqual([])
    await app.close()
  })

  it('forbids a viewer from deleting a candidate (403)', async () => {
    const { app } = await buildTestApp({ withDir: true, claims: { sub: 'v', name: 'V', groups: ['fr-viewers'] } })
    const cookie = await login(app)
    const res = await app.inject({ method: 'DELETE', url: '/api/env/dev/candidates/x', headers: { cookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
