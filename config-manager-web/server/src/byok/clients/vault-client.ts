import type { SecretManagerClient } from '../types.js'

export interface VaultConfig {
  addr: string
  token: string
  /** KV v2 mount path. Default 'secret'. */
  mount?: string
  fetch?: typeof fetch
}

/** HashiCorp Vault KV v2 client over HTTP (no SDK). */
export class VaultClient implements SecretManagerClient {
  private readonly addr: string
  private readonly token: string
  private readonly mount: string
  private readonly fetchImpl: typeof fetch
  constructor(cfg: VaultConfig) {
    this.addr = cfg.addr.replace(/\/+$/, '')
    this.token = cfg.token
    this.mount = cfg.mount ?? 'secret'
    this.fetchImpl = cfg.fetch ?? fetch
  }
  private dataUrl(ref: string): string { return `${this.addr}/v1/${this.mount}/data/${ref}` }

  async writeSecret(ref: string, secret: string): Promise<void> {
    const resp = await this.fetchImpl(this.dataUrl(ref), {
      method: 'POST',
      headers: { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { value: secret } }),
    })
    if (!resp.ok) throw new Error(`[vault] write failed: HTTP ${resp.status}`)
  }

  async secretExists(ref: string): Promise<boolean> {
    const resp = await this.fetchImpl(this.dataUrl(ref), { method: 'GET', headers: { 'X-Vault-Token': this.token } })
    if (resp.status === 404) return false
    if (!resp.ok) throw new Error(`[vault] read failed: HTTP ${resp.status}`)
    return true
  }
}
