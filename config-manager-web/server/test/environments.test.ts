import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentRegistry } from '../src/environments.js'

describe('EnvironmentRegistry', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-env-'))
    file = join(dir, 'environments.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const sample = [{
    id: 'dev', label: 'Development',
    paths: { config: '/c.json', rules: '/r.json', env: '/.env', pricing: '/p.json', optimizedStore: '/o.json', candidates: '/cand.json', byok: '/byok.json' },
  }]

  it('loads environments and looks them up by id', () => {
    writeFileSync(file, JSON.stringify(sample), 'utf-8')
    const reg = EnvironmentRegistry.load(file)
    expect(reg.list().map(e => e.id)).toEqual(['dev'])
    expect(reg.get('dev')?.label).toBe('Development')
    expect(reg.get('nope')).toBeUndefined()
  })

  it('throws on a malformed environments file', () => {
    writeFileSync(file, '{ not json', 'utf-8')
    expect(() => EnvironmentRegistry.load(file)).toThrow(/environments/i)
  })

  it('throws when an entry is missing a required path', () => {
    writeFileSync(file, JSON.stringify([{ id: 'x', label: 'X', paths: { config: '/c.json' } }]), 'utf-8')
    expect(() => EnvironmentRegistry.load(file)).toThrow(/path/i)
  })
})
