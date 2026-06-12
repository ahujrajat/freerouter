import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../src/store/audit-log.js'

describe('AuditLog', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fr-audit-')); path = join(dir, 'audit.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends records and reads them back newest-first', () => {
    const log = new AuditLog(path)
    log.record({ subject: 'alice', environment: 'dev', action: 'config:save', target: 'config', beforeHash: 'a', afterHash: 'b' })
    log.record({ subject: 'bob', environment: 'prod', action: 'config:save', target: 'config', beforeHash: 'c', afterHash: 'd' })
    const recent = log.recent(10)
    expect(recent).toHaveLength(2)
    expect(recent[0]!.subject).toBe('bob')
    expect(typeof recent[0]!.timestamp).toBe('number')
  })

  it('returns empty when the log file does not exist yet', () => {
    expect(new AuditLog(join(dir, 'missing.jsonl')).recent(10)).toEqual([])
  })
})
