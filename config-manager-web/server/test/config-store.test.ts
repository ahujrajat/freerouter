import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileStore, StaleVersionError } from '../src/store/config-store.js'

describe('JsonFileStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-store-')); path = join(dir, 'config.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns empty object + stable version when file is absent', () => {
    const store = new JsonFileStore(path)
    const a = store.read()
    expect(a.data).toEqual({})
    const b = store.read()
    expect(b.version).toBe(a.version)
  })

  it('writes data and round-trips it with a new version', () => {
    const store = new JsonFileStore(path)
    const { version } = store.read()
    const next = store.write({ defaultModel: 'gpt-4o' }, version)
    expect(next.data).toEqual({ defaultModel: 'gpt-4o' })
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ defaultModel: 'gpt-4o' })
    expect(store.read().version).toBe(next.version)
  })

  it('rejects a write whose version no longer matches disk (optimistic lock)', () => {
    const store = new JsonFileStore(path)
    const stale = store.read().version
    store.write({ a: 1 }, stale)
    expect(() => store.write({ a: 2 }, stale)).toThrow(StaleVersionError)
  })

  it('writes atomically (no .tmp left behind)', () => {
    const store = new JsonFileStore(path)
    store.write({ a: 1 }, store.read().version)
    expect(existsSync(path + '.tmp')).toBe(false)
  })
})
