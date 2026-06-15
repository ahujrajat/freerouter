import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpendRecords, buildReport } from '../src/reporting/spend-report.js'
import type { SpendRecord } from 'freerouter'

function makeRecord(overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    userId: 'u1',
    provider: 'openai',
    model: 'gpt-4o',
    tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costUsd: 0.01,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('readSpendRecords', () => {
  it('returns empty array when file does not exist', () => {
    const result = readSpendRecords('/tmp/nonexistent-file-abc123.jsonl')
    expect(result).toEqual([])
  })

  it('returns empty array when file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    const path = join(dir, 'empty.jsonl')
    writeFileSync(path, '', 'utf-8')
    expect(readSpendRecords(path)).toEqual([])
  })

  it('parses a JSONL file (one record per line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    const path = join(dir, 'spend.jsonl')
    const r1 = makeRecord({ userId: 'alice', costUsd: 0.05 })
    const r2 = makeRecord({ userId: 'bob', costUsd: 0.10 })
    writeFileSync(path, [JSON.stringify(r1), JSON.stringify(r2)].join('\n'), 'utf-8')
    const records = readSpendRecords(path)
    expect(records).toHaveLength(2)
    expect(records[0].userId).toBe('alice')
    expect(records[1].userId).toBe('bob')
  })

  it('parses a JSON-array file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    const path = join(dir, 'spend.json')
    const r1 = makeRecord({ userId: 'carol', costUsd: 0.07 })
    const r2 = makeRecord({ userId: 'dave', costUsd: 0.03 })
    writeFileSync(path, JSON.stringify([r1, r2]), 'utf-8')
    const records = readSpendRecords(path)
    expect(records).toHaveLength(2)
    expect(records[0].userId).toBe('carol')
    expect(records[1].userId).toBe('dave')
  })

  it('skips corrupt JSONL lines without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    const path = join(dir, 'spend.jsonl')
    const good = makeRecord({ userId: 'alice' })
    writeFileSync(path, [JSON.stringify(good), 'NOT JSON', JSON.stringify(makeRecord({ userId: 'bob' }))].join('\n'), 'utf-8')
    const records = readSpendRecords(path)
    expect(records).toHaveLength(2)
  })
})

describe('buildReport', () => {
  const now = Date.now()
  const DAY = 86_400_000

  const records: SpendRecord[] = [
    makeRecord({ userId: 'alice', teamId: 'eng', departmentId: 'product', provider: 'openai', model: 'gpt-4o', costUsd: 0.10, tokens: { promptTokens: 200, completionTokens: 100, totalTokens: 300 }, timestamp: now - 2 * DAY }),
    makeRecord({ userId: 'alice', teamId: 'eng', departmentId: 'product', provider: 'openai', model: 'gpt-4o', costUsd: 0.05, tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, timestamp: now - 1 * DAY }),
    makeRecord({ userId: 'bob', teamId: 'data', departmentId: 'analytics', provider: 'anthropic', model: 'claude-3-5-sonnet', costUsd: 0.20, tokens: { promptTokens: 400, completionTokens: 200, totalTokens: 600 }, timestamp: now }),
  ]

  it('totals cost, requests, and tokens correctly', () => {
    const report = buildReport(records)
    expect(report.totals.costUsd).toBeCloseTo(0.35, 5)
    expect(report.totals.requests).toBe(3)
    expect(report.totals.tokens).toBe(1050)
  })

  it('computes range from/to from timestamp min/max', () => {
    const report = buildReport(records)
    expect(report.range.from).toBe(now - 2 * DAY)
    expect(report.range.to).toBe(now)
  })

  it('burnRateUsdPerDay is positive and projectedMonthlyUsd = burnRate * 30', () => {
    const report = buildReport(records)
    expect(report.burnRateUsdPerDay).toBeGreaterThan(0)
    expect(report.projectedMonthlyUsd).toBeCloseTo(report.burnRateUsdPerDay * 30, 10)
  })

  it('byProvider buckets sorted descending by cost', () => {
    const report = buildReport(records)
    expect(report.byProvider).toHaveLength(2)
    // anthropic has 0.20, openai has 0.15 — anthropic first
    expect(report.byProvider[0].key).toBe('anthropic')
    expect(report.byProvider[0].costUsd).toBeCloseTo(0.20, 5)
    expect(report.byProvider[1].key).toBe('openai')
    expect(report.byProvider[1].costUsd).toBeCloseTo(0.15, 5)
  })

  it('byModel buckets sorted descending by cost', () => {
    const report = buildReport(records)
    expect(report.byModel).toHaveLength(2)
    expect(report.byModel[0].key).toBe('claude-3-5-sonnet')
    expect(report.byModel[1].key).toBe('gpt-4o')
  })

  it('byUser buckets sorted descending by cost', () => {
    const report = buildReport(records)
    expect(report.byUser).toHaveLength(2)
    expect(report.byUser[0].key).toBe('bob')
    expect(report.byUser[0].costUsd).toBeCloseTo(0.20, 5)
    expect(report.byUser[1].key).toBe('alice')
    expect(report.byUser[1].costUsd).toBeCloseTo(0.15, 5)
  })

  it('byTeam buckets — eng has alice (0.15), data has bob (0.20)', () => {
    const report = buildReport(records)
    expect(report.byTeam).toHaveLength(2)
    expect(report.byTeam[0].key).toBe('data')
    expect(report.byTeam[0].costUsd).toBeCloseTo(0.20, 5)
  })

  it('byDepartment buckets', () => {
    const report = buildReport(records)
    expect(report.byDepartment).toHaveLength(2)
    expect(report.byDepartment[0].key).toBe('analytics')
  })

  it('configured flag propagates to report', () => {
    expect(buildReport([], false).configured).toBe(false)
    expect(buildReport([], true).configured).toBe(true)
    expect(buildReport(records).configured).toBe(true) // default
  })

  it('empty records returns zero totals and null range', () => {
    const report = buildReport([])
    expect(report.totals.costUsd).toBe(0)
    expect(report.totals.requests).toBe(0)
    expect(report.totals.tokens).toBe(0)
    expect(report.range.from).toBeNull()
    expect(report.range.to).toBeNull()
  })
})
