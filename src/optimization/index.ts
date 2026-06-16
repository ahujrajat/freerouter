// Sub-path export: finrouter/optimization
export type {
  ComplexityFeatures, HeuristicWeights, ComplexityScore, SaturationConstants,
} from './complexity-heuristics.js'
export {
  extractFeatures, score, DEFAULT_WEIGHTS, DEFAULT_SATURATION,
} from './complexity-heuristics.js'

export { RequestClassifier } from './classifier.js'
export type { ClassifierStrategy, ClassifierConfig, RequestClass } from './classifier.js'

export { PromptCache } from './prompt-cache.js'
export type {
  CacheScope, CacheKeyInput, OptimizedTemplate, PromptCacheConfig,
} from './prompt-cache.js'

export { GepaBridge } from './gepa-bridge.js'
export type {
  GepaBridgeConfig, BridgeStatus, BridgeResult, OptimizeRequest, OptimizeResponse,
} from './gepa-bridge.js'

export { OptimizationLedger } from './ledger.js'
export type { LedgerEntry, LedgerScopeKey } from './ledger.js'

export { ComplexityGate } from './complexity-gate.js'
export type { GateAction, GateDecision, ComplexityGateConfig } from './complexity-gate.js'

export { OptimizationPipeline } from './pipeline.js'
export type { PipelineOutcome } from './pipeline.js'
