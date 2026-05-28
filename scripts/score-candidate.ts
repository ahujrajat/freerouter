#!/usr/bin/env tsx
/**
 * Score a candidate `RouterConfig` against a JSONL telemetry file.
 *
 * Invoked by the GEPA sidecar's evaluator — replaces a Python re-implementation
 * of `applyRuleAndCost()` with the real TS code, so parity is guaranteed.
 *
 * Usage:
 *   tsx scripts/score-candidate.ts <candidate.json> <telemetry.jsonl> <pricing.json>
 *
 *   <candidate.json>   ReplayCandidateConfig (subset of RouterConfig the
 *                      optimizer evolves).
 *   <telemetry.jsonl>  Append-only stream from FileTelemetrySink.
 *   <pricing.json>     ReplayPricingMap: {provider: {model: {input, output, ...}}}
 *
 * Emits a `ReplayAggregate` JSON object to stdout.
 */

import { readFile } from 'node:fs/promises'
import { ReplayScorer, type ReplayCandidateConfig, type ReplayPricingMap } from '../src/finops/replay-scorer.js'
import type { SpendRecord } from '../src/types.js'

async function main(): Promise<void> {
  const [candidatePath, telemetryPath, pricingPath] = process.argv.slice(2)
  if (candidatePath === undefined || telemetryPath === undefined || pricingPath === undefined) {
    process.stderr.write('Usage: tsx scripts/score-candidate.ts <candidate.json> <telemetry.jsonl> <pricing.json>\n')
    process.exit(2)
  }

  const [candidateRaw, telemetryRaw, pricingRaw] = await Promise.all([
    readFile(candidatePath, 'utf8'),
    readFile(telemetryPath, 'utf8'),
    readFile(pricingPath, 'utf8'),
  ])

  const candidate = JSON.parse(candidateRaw) as ReplayCandidateConfig
  const pricing = JSON.parse(pricingRaw) as ReplayPricingMap
  const records: SpendRecord[] = telemetryRaw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as SpendRecord)

  const scorer = new ReplayScorer(candidate, pricing)
  const result = scorer.score(records)

  process.stdout.write(JSON.stringify(result) + '\n')
}

main().catch(err => {
  process.stderr.write(`[score-candidate] failed: ${String(err)}\n${(err as Error).stack ?? ''}\n`)
  process.exit(1)
})
