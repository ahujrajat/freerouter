import type { BackendName, KeyBackend, SecretManagerClient, StoredKey } from './types.js'

/** Stores keys in an external secret manager; the byok file keeps only a `ref`. */
export class ReferenceKeyBackend implements KeyBackend {
  constructor(readonly name: BackendName, private readonly client: SecretManagerClient) {}

  async materialize(secret: string | undefined, opts: { provider: string; ref?: string }): Promise<StoredKey> {
    const ref = opts.ref
    if (ref === undefined || ref === '') throw new Error('[byok] external backend requires a ref (secret locator)')
    if (secret !== undefined && secret !== '') {
      await this.client.writeSecret(ref, secret)
      return { backend: this.name, last4: secret.slice(-4), ref }
    }
    // Linking an existing secret: it must already resolve. last4 unknown (not read).
    if (!(await this.client.secretExists(ref))) {
      throw new Error(`[byok] secret does not resolve at ref: ${ref}`)
    }
    return { backend: this.name, last4: '', ref }
  }

  async verify(record: StoredKey): Promise<boolean> {
    return record.ref !== undefined && this.client.secretExists(record.ref)
  }

  async destroy(_record: StoredKey): Promise<void> {
    /* Leave the external secret in place; we only drop our local reference. */
  }
}
