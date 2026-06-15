import type { SecretManagerClient } from '../types.js'

/** The slice of @azure/keyvault-secrets SecretClient we use (injectable). */
export interface AzureSecretApi {
  setSecret(name: string, value: string): Promise<unknown>
  getSecret(name: string): Promise<unknown>
}

/** Adapter over @azure/keyvault-secrets. `ref` is the secret name. */
export class AzureKeyVaultClient implements SecretManagerClient {
  constructor(private readonly api: AzureSecretApi) {}
  async writeSecret(ref: string, secret: string): Promise<void> { await this.api.setSecret(ref, secret) }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.getSecret(ref); return true } catch { return false }
  }
}
