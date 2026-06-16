import { validateConfig, validateConfigKeys } from 'finrouter'

export interface ValidationOutcome {
  ok: boolean
  messages: string[]
}

/**
 * Validate a candidate FinRouter config object using the library's own
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

const VALID_RULE_ACTIONS = new Set(['pin', 'strategy', 'block'])

/** Structural validation for a rules array (the JSON file FileRulesSource reads). */
export function validateRulesPayload(rules: unknown): ValidationOutcome {
  if (!Array.isArray(rules)) {
    return { ok: false, messages: ['rules must be a JSON array'] }
  }
  const messages: string[] = []
  rules.forEach((r, i) => {
    const rule = r as Record<string, unknown>
    const at = `rules[${i}]`
    if (typeof rule.id !== 'string' || rule.id === '') messages.push(`${at}.id must be a non-empty string`)
    if (typeof rule.match !== 'object' || rule.match === null) messages.push(`${at}.match must be an object`)
    const action = rule.action as Record<string, unknown> | undefined
    if (action === undefined || typeof action !== 'object') {
      messages.push(`${at}.action must be an object`)
    } else if (typeof action.type !== 'string' || !VALID_RULE_ACTIONS.has(action.type)) {
      messages.push(`${at}.action.type must be one of: ${[...VALID_RULE_ACTIONS].join(', ')}`)
    } else if (action.type === 'pin' && typeof action.model !== 'string') {
      messages.push(`${at}.action.model is required for a pin rule`)
    } else if (action.type === 'block' && typeof action.reason !== 'string') {
      messages.push(`${at}.action.reason is required for a block rule`)
    }
  })
  return { ok: messages.length === 0, messages }
}
