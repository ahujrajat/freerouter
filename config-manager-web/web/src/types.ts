export type Role = 'admin' | 'viewer'
export interface MeResponse { subject: string; name: string; groups: string[] }
export interface EnvSummary { id: string; label: string; role: Role }
export interface VersionedDoc<T = Record<string, unknown>> { data: T; version: string }
export interface ByokEntry { provider: string; backend: string; isSet: boolean; last4?: string; ref?: string }
