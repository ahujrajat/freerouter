import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AuditRecordInput {
  subject: string
  environment: string
  action: string
  target: string
  beforeHash?: string
  afterHash?: string
}

export interface AuditRecord extends AuditRecordInput {
  timestamp: number
}

/** Append-only JSONL audit log of mutating admin actions. */
export class AuditLog {
  constructor(private readonly path: string) {}

  record(input: AuditRecordInput): void {
    const rec: AuditRecord = { timestamp: Date.now(), ...input }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf-8')
  }

  /** Most recent `limit` records, newest first. */
  recent(limit: number): AuditRecord[] {
    if (!existsSync(this.path)) return []
    const lines = readFileSync(this.path, 'utf-8').split('\n').filter(l => l.trim() !== '')
    const out: AuditRecord[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i]!) as AuditRecord) } catch { /* skip corrupt line */ }
    }
    return out
  }
}
