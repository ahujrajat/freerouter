import { Issuer, generators } from 'openid-client'
import type { Client } from 'openid-client'
import type { OidcConfig } from '../types.js'

export interface AuthRequest {
  state: string
  nonce: string
  redirectUri: string
}

export interface ExchangeRequest {
  callbackUrl: string
  state: string
  nonce: string
}

export interface Claims {
  sub: string
  name: string
  groups: string[]
}

export interface OidcProvider {
  authUrl(req: AuthRequest): string
  exchange(req: ExchangeRequest): Promise<Claims>
}

export const newState = (): string => generators.state()
export const newNonce = (): string => generators.nonce()

/** Real OIDC provider backed by openid-client. Build once at startup via `create`. */
export class OpenIdConnectProvider implements OidcProvider {
  private constructor(private readonly client: Client, private readonly cfg: OidcConfig) {}

  static async create(cfg: OidcConfig): Promise<OpenIdConnectProvider> {
    const issuer = await Issuer.discover(cfg.issuer)
    const client = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [cfg.redirectUri],
      response_types: ['code'],
    })
    return new OpenIdConnectProvider(client, cfg)
  }

  authUrl(req: AuthRequest): string {
    return this.client.authorizationUrl({
      scope: this.cfg.scopes,
      state: req.state,
      nonce: req.nonce,
      redirect_uri: req.redirectUri,
    })
  }

  async exchange(req: ExchangeRequest): Promise<Claims> {
    const params = this.client.callbackParams(req.callbackUrl)
    const tokenSet = await this.client.callback(this.cfg.redirectUri, params, {
      state: req.state,
      nonce: req.nonce,
    })
    const claims = tokenSet.claims()
    const groupsRaw = (claims as Record<string, unknown>)[this.cfg.groupsClaim]
    const groups = Array.isArray(groupsRaw)
      ? groupsRaw.filter((g): g is string => typeof g === 'string')
      : []
    return {
      sub: claims.sub,
      name:
        (claims.name as string | undefined) ??
        (claims.preferred_username as string | undefined) ??
        claims.sub,
      groups,
    }
  }
}
