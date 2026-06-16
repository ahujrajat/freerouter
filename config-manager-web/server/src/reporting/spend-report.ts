import { existsSync, readFileSync } from 'node:fs'
import type { SpendRecord } from 'finrouter'

export interface Bucket { key: string; costUsd: number; requests: number; tokens: number }
export interface SpendReport {
  configured: boolean
  totals: { costUsd: number; requests: number; tokens: number }
  range: { from: number | null; to: number | null }
  burnRateUsdPerDay: number
  projectedMonthlyUsd: number
  byProvider: Bucket[]
  byModel: Bucket[]
  byUser: Bucket[]
  byTeam: Bucket[]
  byDepartment: Bucket[]
}

const DAY = 86_400_000

/** Read spend records from a JSONL (one record/line) OR a JSON array file. */
export function readSpendRecords(path: string): SpendRecord[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf-8').trim()
  if (text === '') return []
  if (text[0] === '[') {
    try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr as SpendRecord[] : [] }
    catch { return [] }
  }
  const out: SpendRecord[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { out.push(JSON.parse(t) as SpendRecord) } catch { /* skip corrupt line */ }
  }
  return out
}

function bucketize(records: SpendRecord[], keyOf: (r: SpendRecord) => string | undefined): Bucket[] {
  const m = new Map<string, Bucket>()
  for (const r of records) {
    const key = keyOf(r)
    if (key === undefined || key === '') continue
    const b = m.get(key) ?? { key, costUsd: 0, requests: 0, tokens: 0 }
    b.costUsd += r.costUsd ?? 0
    b.requests += 1
    b.tokens += r.tokens?.totalTokens ?? 0
    m.set(key, b)
  }
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd)
}

export function buildReport(records: SpendRecord[], configured = true): SpendReport {
  let cost = 0, tokens = 0, from: number | null = null, to: number | null = null
  for (const r of records) {
    cost += r.costUsd ?? 0
    tokens += r.tokens?.totalTokens ?? 0
    if (typeof r.timestamp === 'number') {
      from = from === null ? r.timestamp : Math.min(from, r.timestamp)
      to = to === null ? r.timestamp : Math.max(to, r.timestamp)
    }
  }
  const spanDays = from !== null && to !== null ? Math.max(1, (to - from) / DAY) : 1
  const burn = cost / spanDays
  return {
    configured,
    totals: { costUsd: cost, requests: records.length, tokens },
    range: { from, to },
    burnRateUsdPerDay: burn,
    projectedMonthlyUsd: burn * 30,
    byProvider: bucketize(records, r => r.provider),
    byModel: bucketize(records, r => r.model),
    byUser: bucketize(records, r => r.userId),
    byTeam: bucketize(records, r => r.teamId),
    byDepartment: bucketize(records, r => r.departmentId),
  }
}
