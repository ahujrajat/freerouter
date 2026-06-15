export type Role = 'admin' | 'viewer'
export interface MeResponse { subject: string; name: string; groups: string[] }
export interface EnvSummary { id: string; label: string; role: Role }
export interface VersionedDoc<T = Record<string, unknown>> { data: T; version: string }
export interface ByokEntry { provider: string; backend: string; isSet: boolean; last4?: string; ref?: string }
export type FetchedPricing = Record<string, Record<string, { input: number; output: number; cachedInput?: number }>>

export interface CandidateRow {
  fingerprint: string; model: string; count: number
  estPredictedSavingsUsd: number; status: string
}

export interface AuditRow {
  timestamp: number; subject: string; environment: string; action: string; target: string; description?: string
}

export interface ReportBucket { key: string; costUsd: number; requests: number; tokens: number }
export interface SpendReport {
  configured: boolean
  totals: { costUsd: number; requests: number; tokens: number }
  range: { from: number | null; to: number | null }
  burnRateUsdPerDay: number
  projectedMonthlyUsd: number
  byProvider: ReportBucket[]
  byModel: ReportBucket[]
  byUser: ReportBucket[]
  byTeam: ReportBucket[]
  byDepartment: ReportBucket[]
}
