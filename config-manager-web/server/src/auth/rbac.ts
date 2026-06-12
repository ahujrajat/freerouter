import type { Role } from '../types.js'

export interface RoleMapping {
  /** group -> role applied in every environment unless overridden. */
  defaults: Record<string, Role>
  /** environment id -> (group -> role) override; replaces the default for that env. */
  perEnvironment?: Record<string, Record<string, Role>>
}

const RANK: Record<Role, number> = { viewer: 1, admin: 2 }

/** Resolves a user's effective role in an environment from their IdP groups. */
export class RoleResolver {
  constructor(private readonly mapping: RoleMapping) {}

  roleFor(groups: string[], environmentId: string): Role | undefined {
    const override = this.mapping.perEnvironment?.[environmentId]
    let best: Role | undefined
    for (const g of groups) {
      const role = override?.[g] ?? this.mapping.defaults[g]
      if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role
    }
    return best
  }
}
