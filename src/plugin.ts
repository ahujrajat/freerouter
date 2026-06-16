import type { FinRouter } from './router.js'

/**
 * Plugin interface for extending FinRouter with reusable capabilities.
 * Install via router.use(plugin).
 */
export interface FinRouterPlugin {
  /** Unique name — duplicate installs are silently skipped */
  name: string
  install(router: FinRouter): void
}
