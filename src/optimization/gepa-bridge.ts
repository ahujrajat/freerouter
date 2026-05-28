import type { ChatRequest } from '../types.js'
import type { OptimizedTemplate } from './prompt-cache.js'

export interface OptimizeRequest {
  classSignature: string
  targetModel: string
  fallbackModel: string
  /** Original request the optimizer should specialize for. */
  sample: { messages: ChatRequest['messages']; model: string }
  /** Reference outputs from the (more capable) fallback model, if available. */
  references?: Array<{ messages: ChatRequest['messages']; output: string }>
  /** Per-call budget overrides. */
  maxOptimizationSeconds?: number
  maxMetricCalls?: number
  maxReflectionUsd?: number
  /** Free-form context — sidecar may include in reflection prompt. */
  background?: string
}

export interface OptimizeResponse {
  template: string
  /** Quality gate score 0-1 (relative to fallback model baseline). */
  qualityScore: number
  /** USD spent on reflection + judging during the optimization run. */
  optimizationUsd: number
  /** Predicted per-request savings vs fallback. */
  predictedSavingsUsd: number
  /** Records picked up at quality-gate stage. */
  breakEvenRequests: number
  /** Free-form metadata (run id, GEPA total_metric_calls, etc.). */
  meta?: Record<string, unknown>
}

export interface GepaBridgeConfig {
  /** Base URL of the sidecar, e.g. "http://127.0.0.1:8765". */
  sidecarUrl: string
  /** Optional shared-secret header. */
  authToken?: string
  /** Default per-call timeout in ms. Default: 60_000. */
  timeoutMs?: number
  /** Override the global `fetch`. Primarily for tests. */
  fetch?: typeof fetch
}

export type BridgeStatus = 'ok' | 'sidecar-unreachable' | 'timeout' | 'quality-gate-failed' | 'budget-exceeded'

export interface BridgeResult {
  status: BridgeStatus
  template?: OptimizedTemplate
  optimizationUsd?: number
  qualityScore?: number
  error?: string
}

/**
 * Thin HTTP client to the GEPA optimization sidecar. Translates a TS-side
 * `OptimizeRequest` into a JSON POST and maps the response into the shape
 * the router's optimization branch expects.
 *
 * Failure modes are squashed into `BridgeStatus` so the caller can route
 * cleanly to the fallback model without try/catch handling.
 */
export class GepaBridge {
  private readonly sidecarUrl: string
  private readonly authToken: string | undefined
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: GepaBridgeConfig) {
    this.sidecarUrl = config.sidecarUrl.replace(/\/+$/, '')
    this.authToken  = config.authToken
    this.timeoutMs  = config.timeoutMs ?? 60_000
    this.fetchImpl  = config.fetch ?? fetch
  }

  /** Liveness probe. Returns true if the sidecar reports healthy within 2 s. */
  async health(): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2_000)
      try {
        const resp = await this.fetchImpl(`${this.sidecarUrl}/health`, { signal: ctrl.signal })
        return resp.ok
      } finally { clearTimeout(t) }
    } catch {
      return false
    }
  }

  async optimize(req: OptimizeRequest): Promise<BridgeResult> {
    const ctrl = new AbortController()
    const wallTimeoutMs = (req.maxOptimizationSeconds !== undefined
      ? req.maxOptimizationSeconds * 1000
      : this.timeoutMs)
    const t = setTimeout(() => ctrl.abort(), wallTimeoutMs)

    try {
      const resp = await this.fetchImpl(`${this.sidecarUrl}/optimize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken !== undefined && { Authorization: `Bearer ${this.authToken}` }),
        },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      })

      if (resp.status === 408) {
        return { status: 'timeout' }
      }
      if (resp.status === 402) {
        return { status: 'budget-exceeded' }
      }
      if (resp.status === 422) {
        return { status: 'quality-gate-failed' }
      }
      if (!resp.ok) {
        return { status: 'sidecar-unreachable', error: `HTTP ${resp.status}` }
      }

      const body = await resp.json() as OptimizeResponse
      return {
        status: 'ok',
        template: {
          template: body.template,
          ...(body.meta !== undefined && { meta: body.meta }),
        },
        optimizationUsd: body.optimizationUsd,
        qualityScore: body.qualityScore,
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if ((err as Error).name === 'AbortError') return { status: 'timeout' }
      return { status: 'sidecar-unreachable', error: msg }
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * Post a ledger entry after a request was served by an optimized template.
   * Fire-and-forget — failures do not affect the request.
   */
  async reportUsage(payload: {
    classSignature: string
    targetModel: string
    fallbackModel: string
    actualCostUsd: number
    qualityOk?: boolean
  }): Promise<void> {
    try {
      await this.fetchImpl(`${this.sidecarUrl}/ledger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken !== undefined && { Authorization: `Bearer ${this.authToken}` }),
        },
        body: JSON.stringify(payload),
      })
    } catch {
      /* swallow — ledger reporting is best-effort */
    }
  }
}
