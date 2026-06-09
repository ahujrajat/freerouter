import type { SpendRecord } from '../types.js'
import type { CandidateEntry } from './fingerprint-store.js'

export interface CandidateDetectorConfig {
  /** Per-1M input price of the cheap target model. */
  targetInputPer1M: number
  /** Model input rate at/above which a model counts as "costly". */
  costlyModelInputPer1M: number
  /** Minimum observations before a fingerprint qualifies. */
  minObservations: number
  /** Flat estimate of one optimization run's USD cost, for break-even. */
  optimizationCostUsdEstimate: number
  /** Known per-model input rates (USD / 1M tokens), e.g. from the registry. */
  modelInputRates: Record<string, number>
}

interface Agg {
  fingerprint: string
  simhash: string
  model: string
  count: number
  totalCostUsd: number
  totalPromptTokens: number
  lastSeen: number
}

export interface Observation {
  record: SpendRecord
  fingerprint: string
  simhash: string
}

/** Aggregates spend observations per fingerprint and ranks optimization candidates. */
export class CandidateDetector {
  private readonly aggs = new Map<string, Agg>()

  constructor(private readonly cfg: CandidateDetectorConfig) {}

  /** Record/update a model's input rate observed at runtime (USD / 1M tokens). */
  setModelRate(model: string, inputPer1M: number): void {
    this.cfg.modelInputRates[model] = inputPer1M
  }

  observe(obs: Observation): void {
    const { record, fingerprint, simhash } = obs
    const existing = this.aggs.get(fingerprint)
    if (existing === undefined) {
      this.aggs.set(fingerprint, {
        fingerprint, simhash, model: record.model, count: 1,
        totalCostUsd: record.costUsd, totalPromptTokens: record.tokens.promptTokens,
        lastSeen: record.timestamp,
      })
      return
    }
    existing.count += 1
    existing.totalCostUsd += record.costUsd
    existing.totalPromptTokens += record.tokens.promptTokens
    existing.lastSeen = Math.max(existing.lastSeen, record.timestamp)
  }

  computeCandidates(): CandidateEntry[] {
    const rateSpread = (model: string): number => {
      const fallbackRate = this.cfg.modelInputRates[model] ?? 0
      return Math.max(0, fallbackRate - this.cfg.targetInputPer1M)
    }
    const out: CandidateEntry[] = []
    for (const a of this.aggs.values()) {
      const modelRate = this.cfg.modelInputRates[a.model] ?? 0
      if (modelRate < this.cfg.costlyModelInputPer1M) continue
      if (a.count < this.cfg.minObservations) continue
      const avgTokens = a.totalPromptTokens / a.count
      const savingsPerReq = (avgTokens / 1_000_000) * rateSpread(a.model)
      if (savingsPerReq <= 0) continue
      const estPredictedSavingsUsd = savingsPerReq * a.count
      const estBreakEvenReqs = Math.ceil(this.cfg.optimizationCostUsdEstimate / savingsPerReq)
      out.push({
        fingerprint: a.fingerprint, simhash: a.simhash, model: a.model,
        count: a.count, totalCostUsd: a.totalCostUsd, lastSeen: a.lastSeen,
        estPredictedSavingsUsd, estBreakEvenReqs,
        sampleClassSignature: a.fingerprint, status: 'observed',
      })
    }
    out.sort((x, y) => y.estPredictedSavingsUsd - x.estPredictedSavingsUsd)
    return out
  }
}
