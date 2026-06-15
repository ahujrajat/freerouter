import { describe, it, expect } from 'vitest'
import { ReferenceKeyBackend } from '../src/byok/reference-backend.js'
import type { SecretManagerClient } from '../src/byok/types.js'

class FakeClient implements SecretManagerClient {
  public written: Record<string, string> = {}
  async writeSecret(ref: string, secret: string) { this.written[ref] = secret }
  async secretExists(ref: string) { return ref in this.written }
}

describe('ReferenceKeyBackend', () => {
  it('writes the secret to the manager and records the ref (no enc)', async () => {
    const client = new FakeClient()
    const b = new ReferenceKeyBackend('vault', client)
    const rec = await b.materialize('sk-abcd', { provider: 'openai', ref: 'secret/fr/openai' })
    expect(rec).toMatchObject({ backend: 'vault', last4: 'abcd', ref: 'secret/fr/openai' })
    expect(rec.enc).toBeUndefined()
    expect(client.written['secret/fr/openai']).toBe('sk-abcd')
  })

  it('links an existing secret (no secret provided) when it resolves', async () => {
    const client = new FakeClient()
    client.written['secret/fr/existing'] = 'preset'
    const b = new ReferenceKeyBackend('vault', client)
    const rec = await b.materialize(undefined, { provider: 'x', ref: 'secret/fr/existing' })
    expect(rec.ref).toBe('secret/fr/existing')
    expect(rec.last4).toBe('')
    expect(rec.enc).toBeUndefined()
  })

  it('requires a ref', async () => {
    const b = new ReferenceKeyBackend('vault', new FakeClient())
    await expect(b.materialize('s', { provider: 'x' })).rejects.toThrow(/ref/i)
  })

  it('throws linking a non-existent secret with no secret to write', async () => {
    const b = new ReferenceKeyBackend('vault', new FakeClient())
    await expect(b.materialize(undefined, { provider: 'x', ref: 'secret/missing' })).rejects.toThrow(/exist|resolve/i)
  })

  it('verify delegates to secretExists; destroy is a no-op (ref retained externally)', async () => {
    const client = new FakeClient()
    client.written['r'] = 'v'
    const b = new ReferenceKeyBackend('vault', client)
    expect(await b.verify({ backend: 'vault', last4: 'x', ref: 'r' })).toBe(true)
    expect(await b.verify({ backend: 'vault', last4: 'x', ref: 'nope' })).toBe(false)
  })
})

import { AwsSecretsManagerClient } from '../src/byok/clients/aws-client.js'
import { AzureKeyVaultClient } from '../src/byok/clients/azure-client.js'
import { GcpSecretManagerClient } from '../src/byok/clients/gcp-client.js'

describe('external client adapters (fake-injected)', () => {
  it('AWS: writeSecret puts then falls back to create; exists via describe', async () => {
    const sent: unknown[] = []
    const api = { send: async (c: unknown) => { sent.push(c); return {} } }
    const cmds = {
      Put: class { constructor(public i: unknown) {} },
      Create: class { constructor(public i: unknown) {} },
      Describe: class { constructor(public i: unknown) {} },
    }
    const c = new AwsSecretsManagerClient(api, cmds as never)
    await c.writeSecret('fr/openai', 'sk')
    expect(sent[0]).toBeInstanceOf(cmds.Put)
    expect(await c.secretExists('fr/openai')).toBe(true)
  })

  it('Azure: writeSecret calls setSecret; exists via getSecret', async () => {
    const calls: string[] = []
    const api = { setSecret: async (n: string) => { calls.push(`set:${n}`) }, getSecret: async (n: string) => { calls.push(`get:${n}`); return {} } }
    const c = new AzureKeyVaultClient(api)
    await c.writeSecret('openai', 'sk')
    expect(calls).toContain('set:openai')
    expect(await c.secretExists('openai')).toBe(true)
  })

  it('GCP: writeSecret addSecretVersion; exists via accessSecretVersion', async () => {
    const calls: string[] = []
    const api = {
      addSecretVersion: async (r: { parent: string }) => { calls.push(`add:${r.parent}`) },
      accessSecretVersion: async (r: { name: string }) => { calls.push(`acc:${r.name}`); return {} },
    }
    const c = new GcpSecretManagerClient(api)
    await c.writeSecret('projects/p/secrets/openai', 'sk')
    expect(calls[0]).toBe('add:projects/p/secrets/openai')
    expect(await c.secretExists('projects/p/secrets/openai')).toBe(true)
  })
})
