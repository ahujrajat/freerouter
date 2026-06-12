import { validateConfig, validateConfigKeys } from 'freerouter'

export interface ValidationOutcome {
  ok: boolean
  messages: string[]
}

/**
 * Validate a candidate FreeRouter config object using the library's own
 * validators: unknown top-level keys (typo detection) plus structural checks.
 * Returns a flat list of human-readable messages for the API's 422 response.
 */
export function validateConfigPayload(config: unknown): ValidationOutcome {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, messages: ['config must be a JSON object'] }
  }
  const messages: string[] = []

  const unknown = validateConfigKeys(config as Record<string, unknown>)
  for (const k of unknown) messages.push(`unknown top-level config key: "${k}"`)

  const structural = validateConfig(config)
  if (!structural.valid) {
    for (const e of structural.errors) messages.push(e)
  }

  return { ok: messages.length === 0, messages }
}
