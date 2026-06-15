export interface OptimizeRequest {
  classSignature: string
  targetModel: string
  fallbackModel: string
  sample: { messages: { role: string; content: string }[]; model: string }
}

export interface OptimizeResult {
  template: string
  qualityScore: number
  predictedSavingsUsd: number
}

export interface SidecarClient {
  optimize(req: OptimizeRequest): Promise<OptimizeResult>
}

/** Calls the GEPA sidecar `/optimize` over HTTP. */
export class HttpSidecarClient implements SidecarClient {
  constructor(private readonly url: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async optimize(req: OptimizeRequest): Promise<OptimizeResult> {
    const resp = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token !== undefined && { Authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify(req),
    })
    if (!resp.ok) throw new Error(`sidecar /optimize failed: HTTP ${resp.status}`)
    const body = await resp.json() as { template: string; qualityScore?: number; predictedSavingsUsd?: number }
    return { template: body.template, qualityScore: body.qualityScore ?? 0, predictedSavingsUsd: body.predictedSavingsUsd ?? 0 }
  }
}
