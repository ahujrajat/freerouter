import type { BackendName, KeyBackend } from './types.js'

export class KeyBackendRegistry {
  constructor(private readonly backends: Partial<Record<BackendName, KeyBackend>>) {}
  get(name: BackendName): KeyBackend {
    const b = this.backends[name]
    if (b === undefined) throw new Error(`[byok] backend "${name}" is not configured on this server`)
    return b
  }
  available(): BackendName[] {
    return Object.keys(this.backends) as BackendName[]
  }
}
