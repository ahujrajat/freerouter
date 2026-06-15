import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestApp } from './helpers.js'

describe('static SPA serving', () => {
  let webDir: string
  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), 'fr-web-'))
    mkdirSync(join(webDir, 'assets'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root">APP</div>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)')
  })
  afterEach(() => rmSync(webDir, { recursive: true, force: true }))

  it('serves index.html at /', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('APP')
    await app.close()
  })

  it('serves built assets', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('SPA fallback: unknown non-API path returns index.html (not 404)', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/some/client/route' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('APP')
    await app.close()
  })

  it('unknown /api path still 404s (not the SPA)', async () => {
    const app = await buildTestApp({ webDistDir: webDir })
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('with no webDistDir, / is not served (404)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
