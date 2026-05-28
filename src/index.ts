/**
 * FreeRouter — Public API barrel
 *
 * Import everything from 'freerouter'.
 * Sub-path imports available: 'freerouter/providers', 'freerouter/security', 'freerouter/finops', 'freerouter/adapters'
 */

// Main class
export { FreeRouter } from './router.js'

// Config
export type {
  RouterConfig, ProviderToggle, SpendPersistenceConfig, PricingRefreshConfig,
  RulesRefreshConfig, TelemetryExportConfig, ShadowRouterConfig,
  PromptOptimizationConfig,
} from './config.js'

// Config file loader
export { loadConfigFile, loadConfigFromEnv, mergeConfigs, validateConfigKeys } from './config-loader.js'
export type { FileConfig } from './config-loader.js'

// Config validator
export { validateConfig } from './config-validator.js'
export type { ConfigValidationResult } from './config-validator.js'

// Plugin
export type { FreeRouterPlugin } from './plugin.js'

// All shared types
export type {
  // Chat
  Message,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  StreamChunk,
  RequestContext,

  // FinOps
  BudgetScope,
  BudgetWindow,
  BudgetPolicy,
  SpendSummary,
  SpendRecord,
  SpendForecast,
  ChargebackReport,
  RateLimitConfig,
  PolicyDecision,
  ModelPricingEntry,

  // Security
  AuditAction,
  AuditEntry,
  AuditSink,

  // Hot-reload lifecycle
  ProviderLifecycleEvent,
  ModelLifecycleEvent,
  RouterEventMap,

  // Health & Metrics
  ProviderHealth,
  HealthStatus,
  LatencyBuckets,
  RouterMetrics,
} from './types.js'

// FinOps — persistence
export type { SpendStore } from './finops/spend-store.js'
export { MemorySpendStore } from './finops/spend-store.js'

// FinOps — telemetry export (offline pipelines / GEPA optimizer)
export type { TelemetrySink } from './finops/telemetry-sink.js'
export { NullTelemetrySink, MemoryTelemetrySink } from './finops/telemetry-sink.js'
export { TelemetryExporter } from './finops/telemetry-exporter.js'
export type { TelemetryExporterOptions } from './finops/telemetry-exporter.js'

// FinOps — replay scoring + shadow router (GEPA pipeline)
export { ReplayScorer } from './finops/replay-scorer.js'
export type {
  ReplayCandidateConfig, ReplayPricingMap, ReplayDecision, ReplayAggregate,
} from './finops/replay-scorer.js'
export { ShadowRouter, MemoryShadowSink } from './finops/shadow-router.js'
export type { ShadowSink, ShadowDecisionRecord } from './finops/shadow-router.js'

// Optimization pipeline (per-request GEPA, complexity gate, ledger, cache, bridge)
export {
  extractFeatures, score, DEFAULT_WEIGHTS, DEFAULT_SATURATION,
} from './optimization/complexity-heuristics.js'
export type {
  ComplexityFeatures, HeuristicWeights, ComplexityScore, SaturationConstants,
} from './optimization/complexity-heuristics.js'
export { RequestClassifier } from './optimization/classifier.js'
export type { ClassifierStrategy, ClassifierConfig, RequestClass } from './optimization/classifier.js'
export { PromptCache } from './optimization/prompt-cache.js'
export type {
  CacheScope, CacheKeyInput, OptimizedTemplate, PromptCacheConfig,
} from './optimization/prompt-cache.js'
export { GepaBridge } from './optimization/gepa-bridge.js'
export type {
  GepaBridgeConfig, BridgeStatus, BridgeResult, OptimizeRequest, OptimizeResponse,
} from './optimization/gepa-bridge.js'
export { OptimizationLedger } from './optimization/ledger.js'
export type { LedgerEntry, LedgerScopeKey } from './optimization/ledger.js'
export { ComplexityGate } from './optimization/complexity-gate.js'
export type { GateAction, GateDecision, ComplexityGateConfig } from './optimization/complexity-gate.js'
export { OptimizationPipeline } from './optimization/pipeline.js'
export type { PipelineOutcome } from './optimization/pipeline.js'

// FinOps — pricing sources
export type {
  PricingSource, PricingManifest, PricingTransform, HttpPricingSourceOptions,
} from './finops/pricing-source.js'
export {
  HttpPricingSource, StaticPricingSource,
  transformLiteLLM, transformOpenRouter,
  liteLLMPricingSource, openRouterPricingSource,
  LITELLM_PRICING_URL, OPENROUTER_PRICING_URL,
} from './finops/pricing-source.js'

// FinOps — cost optimization
export type { CostOptimizationConfig, CostStrategy } from './finops/cost-router.js'

// FinOps — admin rules engine
export { RulesEngine } from './finops/rules-engine.js'
export type {
  Rule,
  RuleAction,
  RuleMatch,
  RuleDecision,
  RulesConfig,
  RulesMode,
} from './finops/rules-engine.js'
export { FileRulesSource } from './adapters/file-rules-source.js'
export type { RulesSource } from './adapters/file-rules-source.js'

// Extensibility
export type { BaseProvider } from './providers/base-provider.js'
export type { KeyStore, StoredKey } from './security/key-manager.js'
export type { RateLimiterLike } from './finops/rate-limiter.js'
