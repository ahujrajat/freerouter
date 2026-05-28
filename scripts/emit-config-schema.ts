#!/usr/bin/env tsx
/**
 * Emit a JSON Schema describing the file-loadable subset of `RouterConfig`
 * plus the GEPA-tunable artifacts (admin rules, cost optimization, budgets).
 *
 * Consumed by:
 *   - editor IntelliSense for `freerouter.config.json` (via `$schema`)
 *   - the GEPA sidecar's `CandidateValidator` (gates evolved candidates
 *     against this shape before scoring)
 *
 * Hand-written rather than auto-generated: the surface is small, stable,
 * and we want full control over `description`s, `enum` constraints, and
 * `additionalProperties` semantics.
 *
 * Usage:
 *   tsx scripts/emit-config-schema.ts                 # → ./schemas/router-config.schema.json
 *   tsx scripts/emit-config-schema.ts <output-path>   # custom path
 *   tsx scripts/emit-config-schema.ts --stdout        # to stdout
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// ── Schema fragments ────────────────────────────────────────────────────────

const tokenUsage = {
  type: 'object',
  additionalProperties: false,
  required: ['promptTokens', 'completionTokens', 'totalTokens'],
  properties: {
    promptTokens:        { type: 'integer', minimum: 0 },
    completionTokens:    { type: 'integer', minimum: 0 },
    totalTokens:         { type: 'integer', minimum: 0 },
    cachedPromptTokens:  { type: 'integer', minimum: 0 },
  },
} as const

const budgetScope = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type'],
      properties: { type: { const: 'global' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'orgId'],
      properties: { type: { const: 'org' }, orgId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'orgId', 'departmentId'],
      properties: { type: { const: 'department' }, orgId: { type: 'string' }, departmentId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'orgId', 'teamId'],
      properties: { type: { const: 'team' }, orgId: { type: 'string' }, teamId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'userId'],
      properties: { type: { const: 'user' }, userId: { type: 'string' } } },
  ],
} as const

const budgetWindow = {
  enum: ['hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'total'],
} as const

const budgetPolicy = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'scope', 'window', 'maxSpendUsd', 'onLimitReached'],
  properties: {
    id:              { type: 'string', minLength: 1 },
    scope:           budgetScope,
    window:          budgetWindow,
    maxSpendUsd:     { type: 'number', minimum: 0 },
    maxTokens:       { type: 'integer', minimum: 0 },
    maxRequests:     { type: 'integer', minimum: 0 },
    modelCaps: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['maxSpendUsd'],
        properties: { maxSpendUsd: { type: 'number', minimum: 0 } },
      },
    },
    onLimitReached:  { enum: ['block', 'warn', 'downgrade', 'notify', 'throttle'] },
    fallbackModel:   { type: 'string' },
    alertThresholds: {
      type: 'array',
      items: { type: 'number', minimum: 0, maximum: 100 },
      uniqueItems: true,
    },
    priority:        { type: 'integer' },
  },
} as const

const rateLimit = {
  type: 'object',
  additionalProperties: false,
  required: ['requestsPerMinute'],
  properties: {
    requestsPerMinute: { type: 'integer', minimum: 1 },
    tokensPerMinute:   { type: 'integer', minimum: 1 },
    burstAllowance:    { type: 'number', minimum: 0 },
    scope:             budgetScope,
  },
} as const

const providerToggle = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled:          { type: 'boolean' },
    routingPrefixes:  { type: 'array', items: { type: 'string' } },
  },
} as const

const pricingEntry = {
  type: 'object',
  additionalProperties: false,
  required: ['input', 'output'],
  properties: {
    input:        { type: 'number', minimum: 0 },
    output:       { type: 'number', minimum: 0 },
    cachedInput:  { type: 'number', minimum: 0 },
  },
} as const

const costOptimization = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'candidateModels'],
  properties: {
    strategy:             { enum: ['cheapest', 'balanced', 'performance'] },
    candidateModels:      { type: 'array', items: { type: 'string' }, minItems: 1 },
    minCostThresholdUsd:  { type: 'number', minimum: 0 },
    batchOnly:            { type: 'boolean' },
  },
} as const

const ruleMatch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userId:        { type: 'string' },
    orgId:         { type: 'string' },
    teamId:        { type: 'string' },
    departmentId:  { type: 'string' },
    modelPattern:  { type: 'string' },
    priority:      { enum: ['realtime', 'batch'] },
    metadata:      { type: 'object', additionalProperties: true },
  },
} as const

const ruleAction = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type', 'model'],
      properties: { type: { const: 'pin' }, model: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'reason'],
      properties: { type: { const: 'block' }, reason: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'strategy'],
      properties: {
        type: { const: 'strategy' },
        strategy: { enum: ['cheapest', 'balanced', 'performance'] },
        candidateModels: { type: 'array', items: { type: 'string' } },
      } },
  ],
} as const

const rule = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'match', 'action'],
  properties: {
    id:       { type: 'string', minLength: 1 },
    priority: { type: 'integer' },
    match:    ruleMatch,
    action:   ruleAction,
  },
} as const

const heuristicWeights = {
  type: 'object',
  additionalProperties: false,
  required: ['tokens', 'instructions', 'code', 'format', 'reasoning', 'constraints', 'references'],
  properties: {
    tokens:       { type: 'number', minimum: 0 },
    instructions: { type: 'number', minimum: 0 },
    code:         { type: 'number', minimum: 0 },
    format:       { type: 'number', minimum: 0 },
    reasoning:    { type: 'number', minimum: 0 },
    constraints:  { type: 'number', minimum: 0 },
    references:   { type: 'number', minimum: 0 },
  },
} as const

const complexityGate = {
  type: 'object',
  additionalProperties: false,
  required: ['targetInputPer1M', 'fallbackInputPer1M'],
  properties: {
    targetInputPer1M:    { type: 'number', minimum: 0 },
    fallbackInputPer1M:  { type: 'number', minimum: 0 },
    minRoiUsd:           { type: 'number', minimum: 0 },
    directFallbackRisk:  { type: 'number', minimum: 0, maximum: 1 },
    heuristicWeights:    heuristicWeights,
    defaultExpectedReuse: { type: 'integer', minimum: 1 },
    defaultCheapModelSuccessRate: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

const promptOptimization = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'mode', 'targetModel', 'fallbackModel', 'gate'],
  properties: {
    enabled:        { type: 'boolean' },
    mode:           { enum: ['template-cached', 'live-single-task', 'off'] },
    targetModel:    { type: 'string' },
    fallbackModel:  { type: 'string' },
    bridge: {
      type: 'object',
      additionalProperties: false,
      required: ['sidecarUrl'],
      properties: {
        sidecarUrl: { type: 'string', format: 'uri' },
        authToken:  { type: 'string' },
        timeoutMs:  { type: 'integer', minimum: 1 },
      },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxEntries: { type: 'integer', minimum: 1 },
        ttlMs:      { type: 'integer', minimum: 1 },
        scope:      { enum: ['global', 'org', 'team', 'user'] },
      },
    },
    classifier: {
      type: 'object',
      additionalProperties: false,
      required: ['strategy'],
      properties: {
        strategy:    { enum: ['metadata', 'rule-based', 'embed-hash'] },
        metadataKey: { type: 'string' },
      },
    },
    gate: complexityGate,
    failClosed: { type: 'boolean' },
  },
} as const

// ── Top-level schema ────────────────────────────────────────────────────────

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id:     'https://freerouter.dev/config-schema.json',
  title:   'FreeRouter configuration',
  description:
    'JSON-serializable subset of RouterConfig. Runtime-only fields (callbacks, ' +
    'SpendStore/TelemetrySink instances, PricingSource adapters) are intentionally ' +
    'absent — they are wired programmatically.',
  type:    'object',
  additionalProperties: true,  // forward-compat for newer keys
  properties: {
    $schema:              { type: 'string' },
    $comment:             { type: 'string' },
    defaultProvider:      { type: 'string' },
    defaultModel:         { type: 'string' },
    masterKey:            { type: 'string', minLength: 64, maxLength: 64,
                            pattern: '^[0-9a-fA-F]{64}$',
                            description: '32-byte AES-256-GCM master key as 64 hex chars.' },
    keyExpiryMs:          { type: 'integer', minimum: 0 },
    maxInputLength:       { type: 'integer', minimum: 1 },
    promptInjectionGuard: { type: 'boolean' },
    requestSigning:       { type: 'boolean' },
    blockedProviders:     { type: 'array', items: { type: 'string' }, uniqueItems: true },
    allowedModels:        { type: 'array', items: { type: 'string' }, uniqueItems: true },
    rateLimit,
    budgets:              { type: 'array', items: budgetPolicy },
    providers:            { type: 'object', additionalProperties: providerToggle },
    audit: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
    pricingOverrides:     { type: 'object', additionalProperties: pricingEntry },
    costOptimization,
    rules: {
      type: 'object',
      additionalProperties: false,
      required: ['rules', 'mode'],
      properties: {
        rules: { type: 'array', items: rule },
        mode:  { enum: ['pin-wins', 'narrow-candidates', 'post-override'] },
      },
    },
    promptOptimization,
  },

  // Auxiliary definitions exposed for the GEPA sidecar — these are the
  // fragments the optimizer evolves as standalone candidates.
  definitions: {
    BudgetScope:    budgetScope,
    BudgetWindow:   budgetWindow,
    BudgetPolicy:   budgetPolicy,
    TokenUsage:     tokenUsage,
    Rule:                 rule,
    RuleAction:           ruleAction,
    RuleMatch:            ruleMatch,
    HeuristicWeights:     heuristicWeights,
    ComplexityGate:       complexityGate,
    PromptOptimization:   promptOptimization,
    CostOptimization: costOptimization,
    PricingEntry:   pricingEntry,
    RateLimit:      rateLimit,
    ProviderToggle: providerToggle,
  },
} as const

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const json = JSON.stringify(schema, null, 2)

  if (argv.includes('--stdout')) {
    process.stdout.write(json + '\n')
    return
  }

  const out = resolve(argv[0] ?? 'schemas/router-config.schema.json')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, json + '\n', 'utf8')
  process.stderr.write(`[emit-config-schema] wrote ${out} (${json.length} bytes)\n`)
}

main().catch(err => {
  process.stderr.write(`[emit-config-schema] failed: ${String(err)}\n`)
  process.exit(1)
})
