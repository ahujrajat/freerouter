import type { SecretManagerClient } from '../types.js'

/** The slice of the AWS SDK SecretsManager client we use (injectable for tests). */
export interface AwsSecretsApi {
  send(command: unknown): Promise<{ ARN?: string }>
}

/** Adapter over @aws-sdk/client-secrets-manager. `ref` is the secret name/ARN. */
export class AwsSecretsManagerClient implements SecretManagerClient {
  constructor(
    private readonly api: AwsSecretsApi,
    private readonly cmds: {
      Create: new (i: { Name: string; SecretString: string }) => unknown
      Put: new (i: { SecretId: string; SecretString: string }) => unknown
      Describe: new (i: { SecretId: string }) => unknown
    },
  ) {}

  async writeSecret(ref: string, secret: string): Promise<void> {
    try {
      await this.api.send(new this.cmds.Put({ SecretId: ref, SecretString: secret }))
    } catch {
      await this.api.send(new this.cmds.Create({ Name: ref, SecretString: secret }))
    }
  }
  async secretExists(ref: string): Promise<boolean> {
    try { await this.api.send(new this.cmds.Describe({ SecretId: ref })); return true }
    catch { return false }
  }
}
