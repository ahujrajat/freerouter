import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StoredKey, ByokPublic } from './types.js'

const toPublic = (provider: string, r: StoredKey): ByokPublic => ({
  provider, backend: r.backend, isSet: true,
  ...(r.last4 !== undefined && { last4: r.last4 }),
  ...(r.ref !== undefined && { ref: r.ref }),
})

/** Per-environment store of BYOK records. Never exposes `enc` through `list`. */
export class ByokStore {
  private readonly records: Record<string, StoredKey>
  constructor(private readonly path: string) {
    this.records = existsSync(path) ? this.read() : {}
  }
  private read(): Record<string, StoredKey> {
    try { return JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, StoredKey> }
    catch { return {} }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
  getRaw(provider: string): StoredKey | undefined { return this.records[provider] }
  upsert(provider: string, record: StoredKey): void { this.records[provider] = record; this.persist() }
  remove(provider: string): void { delete this.records[provider]; this.persist() }
  list(): ByokPublic[] { return Object.entries(this.records).map(([p, r]) => toPublic(p, r)) }
}
