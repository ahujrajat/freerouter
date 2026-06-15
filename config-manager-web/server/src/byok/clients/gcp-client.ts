import type { SecretManagerClient } from '../types.js'

/** The slice of @google-cloud/secret-manager client we use (injectable). */
export interface GcpSecretApi {
  addSecretVersion(req: { parent: string; payload: { data: Buffer } }): Promise<unknown>
  accessSecretVersion(req: { name: string }): Promise<unknown>
}

/** Adapter over @google-cloud/secret-manager. `ref` is `projects/<p>/secrets/<id>`. */
export class GcpSecretManagerClient implements SecretManagerClient {
  constructor(private readonly api: GcpSecretApi) {}
  async writeSecret(ref: string, secret: string): Promise<void> {
    await this.api.addSecretVersion({ parent: ref, payload: { data: Buffer.from(secret, 'utf-8') } })
  }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.accessSecretVersion({ name: `${ref}/versions/latest` }); return true } catch { return false }
  }
}
