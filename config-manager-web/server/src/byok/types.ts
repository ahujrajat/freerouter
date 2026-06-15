export type BackendName = 'local' | 'vault' | 'aws-secrets-manager' | 'azure-key-vault' | 'gcp-secret-manager'

/** Encrypted material persisted by the local backend. */
export interface EncBlob { ciphertext: string; iv: string; tag: string }

/** What is persisted per provider in the per-env byok file. */
export interface StoredKey {
  backend: BackendName
  last4: string
  /** External-manager locator (path/ARN/secret name). Present for external backends. */
  ref?: string
  /** Encrypted secret. Present only for the local backend. Never leaves the server. */
  enc?: EncBlob
}

/** Safe-to-return view (never includes `enc`). */
export interface ByokPublic {
  provider: string
  backend: BackendName
  isSet: boolean
  last4?: string
  ref?: string
}

/** A backend turns a secret into a StoredKey and validates/destroys external material. */
export interface KeyBackend {
  readonly name: BackendName
  /** Produce the record to persist. `ref` is required by external backends. */
  materialize(secret: string | undefined, opts: { provider: string; ref?: string }): Promise<StoredKey>
  /** Confirm the key still resolves (local: enc present; external: client check). */
  verify(record: StoredKey): Promise<boolean>
  /** Remove any external-manager material (local: no-op). */
  destroy(record: StoredKey): Promise<void>
}

/** Minimal external secret-manager transport. */
export interface SecretManagerClient {
  writeSecret(ref: string, secret: string): Promise<void>
  secretExists(ref: string): Promise<boolean>
}
