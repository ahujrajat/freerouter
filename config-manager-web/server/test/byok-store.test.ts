import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ByokStore } from '../src/byok/byok-store.js'

describe('ByokStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-byok-')); path = join(dir, 'byok.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty and lists nothing', () => {
    expect(new ByokStore(path).list()).toEqual([])
  })

  it('upserts a record and exposes only public fields (never enc)', () => {
    const store = new ByokStore(path)
    store.upsert('openai', { backend: 'local', last4: '7890', enc: { ciphertext: 'c', iv: 'i', tag: 't' } })
    const list = store.list()
    expect(list).toEqual([{ provider: 'openai', backend: 'local', isSet: true, last4: '7890' }])
    expect(JSON.stringify(list)).not.toContain('ciphertext')
  })

  it('persists and reloads, and includes ref for external records', () => {
    new ByokStore(path).upsert('anthropic', { backend: 'vault', last4: 'abcd', ref: 'secret/data/fr/anthropic' })
    const reloaded = new ByokStore(path)
    expect(reloaded.list()).toEqual([{ provider: 'anthropic', backend: 'vault', isSet: true, last4: 'abcd', ref: 'secret/data/fr/anthropic' }])
  })

  it('removes a record', () => {
    const store = new ByokStore(path)
    store.upsert('openai', { backend: 'local', last4: '1', enc: { ciphertext: 'c', iv: 'i', tag: 't' } })
    store.remove('openai')
    expect(store.list()).toEqual([])
  })
})
