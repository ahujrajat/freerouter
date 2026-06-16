import { createCipheriv, randomBytes } from 'node:crypto'
import type { KeyBackend, StoredKey } from './types.js'

/** Encrypts secrets at rest with AES-256-GCM. The web manager never decrypts —
 *  it is write-only; decryption belongs to the FinRouter runtime. */
export class LocalKeyBackend implements KeyBackend {
  readonly name = 'local' as const
  private readonly key: Buffer

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error('[byok] local backend requires a 32-byte hex master key (BYOK_MASTER_KEY)')
    }
    this.key = Buffer.from(masterKeyHex, 'hex')
  }

  async materialize(secret: string | undefined, _opts: { provider: string }): Promise<StoredKey> {
    if (secret === undefined || secret === '') throw new Error('[byok] local backend requires a secret')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      backend: 'local',
      last4: secret.slice(-4),
      enc: { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') },
    }
  }

  async verify(record: StoredKey): Promise<boolean> {
    return record.enc !== undefined
  }

  async destroy(_record: StoredKey): Promise<void> {
    /* nothing external to remove */
  }
}
