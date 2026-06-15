import { readFileSync } from 'node:fs'
import type { Environment, EnvironmentPaths } from './types.js'

const REQUIRED_PATHS: (keyof EnvironmentPaths)[] = [
  'config', 'rules', 'env', 'pricing', 'optimizedStore', 'candidates', 'byok',
]

export class EnvironmentRegistry {
  private readonly byId = new Map<string, Environment>()

  private constructor(envs: Environment[]) {
    for (const e of envs) this.byId.set(e.id, e)
  }

  static load(file: string): EnvironmentRegistry {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      throw new Error(`[environments] failed to read/parse ${file}: ${(err as Error).message}`)
    }
    if (!Array.isArray(raw)) {
      throw new Error('[environments] file must contain a JSON array of environments')
    }
    const envs: Environment[] = raw.map((e, i) => {
      const entry = e as Partial<Environment>
      if (typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.paths !== 'object' || entry.paths === null) {
        throw new Error(`[environments] entry ${i} missing id/label/paths`)
      }
      for (const p of REQUIRED_PATHS) {
        if (typeof (entry.paths as unknown as Record<string, unknown>)[p] !== 'string') {
          throw new Error(`[environments] entry "${entry.id}" missing path: ${p}`)
        }
      }
      return entry as Environment
    })
    return new EnvironmentRegistry(envs)
  }

  list(): Environment[] {
    return [...this.byId.values()]
  }

  get(id: string): Environment | undefined {
    return this.byId.get(id)
  }
}
