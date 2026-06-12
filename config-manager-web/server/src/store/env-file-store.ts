import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VersionedDoc } from '../types.js'
import { StaleVersionError } from './config-store.js'

export { StaleVersionError }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1)
    }
    if (key !== '') out[key] = value
  }
  return out
}

function serializeEnv(env: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (key === '') continue
    const needsQuote = value === '' || /[ \t"'#$`\\]/.test(value)
    if (needsQuote) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      lines.push(`${key}="${escaped}"`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** A `.env` file as a string->string map, with raw-text content-hash optimistic locking. */
export class EnvFileStore {
  constructor(private readonly path: string) {}

  private text(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf-8') : ''
  }

  read(): VersionedDoc<Record<string, string>> {
    const raw = this.text()
    return { data: parseEnv(raw), version: sha256(raw) }
  }

  write(env: Record<string, string>, expectedVersion: string): VersionedDoc<Record<string, string>> {
    if (sha256(this.text()) !== expectedVersion) throw new StaleVersionError()
    const serialized = serializeEnv(env)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, serialized, 'utf-8')
    renameSync(tmp, this.path)
    return { data: env, version: sha256(serialized) }
  }
}
