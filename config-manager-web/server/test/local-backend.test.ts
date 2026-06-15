import { describe, it, expect } from 'vitest'
import { createDecipheriv } from 'node:crypto'
import { LocalKeyBackend } from '../src/byok/local-backend.js'

const MASTER = 'a'.repeat(64) // 32 bytes hex

describe('LocalKeyBackend', () => {
  it('encrypts the secret, records last4, and round-trips via the master key', async () => {
    const b = new LocalKeyBackend(MASTER)
    const rec = await b.materialize('sk-test-1234567890', { provider: 'openai' })
    expect(rec.backend).toBe('local')
    expect(rec.last4).toBe('7890')
    expect(rec.enc).toBeDefined()
    expect(rec.ref).toBeUndefined()
    // Decrypt with the master key to prove ciphertext is the real secret (server-internal).
    const key = Buffer.from(MASTER, 'hex')
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.enc!.iv, 'base64'))
    d.setAuthTag(Buffer.from(rec.enc!.tag, 'base64'))
    const plain = Buffer.concat([d.update(Buffer.from(rec.enc!.ciphertext, 'base64')), d.final()]).toString('utf-8')
    expect(plain).toBe('sk-test-1234567890')
  })

  it('verify is true when enc is present, false otherwise', async () => {
    const b = new LocalKeyBackend(MASTER)
    const rec = await b.materialize('secret', { provider: 'x' })
    expect(await b.verify(rec)).toBe(true)
    expect(await b.verify({ backend: 'local', last4: '0000' })).toBe(false)
  })

  it('throws if constructed without a 32-byte hex master key', () => {
    expect(() => new LocalKeyBackend('short')).toThrow(/master key/i)
  })

  it('requires a secret to materialize', async () => {
    const b = new LocalKeyBackend(MASTER)
    await expect(b.materialize(undefined, { provider: 'x' })).rejects.toThrow(/secret/i)
  })
})
