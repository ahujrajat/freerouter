import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VersionedDoc } from '../types.js'

export class StaleVersionError extends Error {
  constructor() {
    super('version mismatch: the document changed on disk')
    this.name = 'StaleVersionError'
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * A JSON document on disk with content-hash optimistic locking. An absent file
 * reads as `{}` with the hash of the empty-object canonical form, so a first
 * write is a normal version transition rather than a special case.
 */
export class JsonFileStore<T extends object = Record<string, unknown>> {
  constructor(private readonly path: string) {}

  private bytes(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf-8') : '{}'
  }

  read(): VersionedDoc<T> {
    const raw = this.bytes()
    return { data: JSON.parse(raw) as T, version: sha256(raw) }
  }

  /** Write `data` iff `expectedVersion` still matches disk; returns the new doc. */
  write(data: T, expectedVersion: string): VersionedDoc<T> {
    const current = sha256(this.bytes())
    if (current !== expectedVersion) throw new StaleVersionError()
    const serialized = JSON.stringify(data, null, 2)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, serialized, 'utf-8')
    renameSync(tmp, this.path)
    return { data, version: sha256(serialized) }
  }
}
