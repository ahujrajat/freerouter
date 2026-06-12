import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvFileStore, StaleVersionError } from '../src/store/env-file-store.js'

describe('EnvFileStore', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-env-')); path = join(dir, '.env') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads {} for an absent file', () => {
    const a = new EnvFileStore(path).read()
    expect(a.data).toEqual({})
  })

  it('parses key=value pairs, skipping comments/blank lines and stripping quotes', () => {
    writeFileSync(path, '# comment\n\nA=1\nB="two words"\nC=plain\n', 'utf-8')
    expect(new EnvFileStore(path).read().data).toEqual({ A: '1', B: 'two words', C: 'plain' })
  })

  it('round-trips, quoting values that need it', () => {
    const store = new EnvFileStore(path)
    const { version } = store.read()
    store.write({ A: '1', B: 'two words', EMPTY: '' }, version)
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('A=1')
    expect(text).toContain('B="two words"')
    expect(text).toContain('EMPTY=""')
    expect(new EnvFileStore(path).read().data).toEqual({ A: '1', B: 'two words', EMPTY: '' })
  })

  it('rejects a stale write (optimistic lock)', () => {
    const store = new EnvFileStore(path)
    const stale = store.read().version
    store.write({ A: '1' }, stale)
    expect(() => store.write({ A: '2' }, stale)).toThrow(StaleVersionError)
  })
})
