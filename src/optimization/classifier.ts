import { createHash } from 'node:crypto'
import type { ChatRequest, RequestContext } from '../types.js'

export interface RequestClass {
  /** Stable signature used as the cache key. */
  signature: string
  /** Optional human-readable label (from metadata or rule match). */
  label?: string
}

export type ClassifierStrategy =
  | 'metadata'    // read from request.metadata[metadataKey]
  | 'rule-based'  // length/structure buckets
  | 'embed-hash'  // SimHash over normalized text (no embedding model required)

export interface ClassifierConfig {
  strategy: ClassifierStrategy
  /** For 'metadata' strategy: key on request.metadata to read. Default: "taskClass". */
  metadataKey?: string
}

export class RequestClassifier {
  constructor(private readonly config: ClassifierConfig) {}

  classify(req: ChatRequest, _ctx: RequestContext): RequestClass {
    switch (this.config.strategy) {
      case 'metadata':   return this.classifyByMetadata(req)
      case 'rule-based': return this.classifyByRule(req)
      case 'embed-hash': return this.classifyByHash(req)
    }
  }

  private classifyByMetadata(req: ChatRequest): RequestClass {
    const key = this.config.metadataKey ?? 'taskClass'
    const raw = req.metadata?.[key]
    if (typeof raw === 'string' && raw.length > 0) {
      return { signature: `md:${raw}`, label: raw }
    }
    // Fall back to rule-based so we never produce an empty signature.
    return this.classifyByRule(req)
  }

  private classifyByRule(req: ChatRequest): RequestClass {
    const text = req.messages.map(m => m.content).join('\n')
    const len = text.length
    const lenBucket = len < 200 ? 'xs' : len < 800 ? 's' : len < 4000 ? 'm' : len < 20000 ? 'l' : 'xl'
    const hasCode  = /```/.test(text) ? 'code' : 'nocode'
    const hasFmt   = /\b(json|xml|yaml|markdown|csv)\b/i.test(text) ? 'fmt' : 'nofmt'
    const model    = req.model.replace(/[^\w-]/g, '_')
    const label    = `${model}:${lenBucket}:${hasCode}:${hasFmt}`
    return { signature: `rb:${label}`, label }
  }

  /**
   * SimHash-like 64-bit class signature. Stable across whitespace
   * differences and minor edits, sensitive to topical content.
   * No external model — pure crypto + bit ops.
   */
  private classifyByHash(req: ChatRequest): RequestClass {
    const text = req.messages.map(m => m.content).join(' ').toLowerCase()
    const tokens = text.match(/[a-z0-9]+/g) ?? []
    if (tokens.length === 0) {
      return { signature: `eh:${req.model}:empty` }
    }
    const bits = new Int32Array(64)
    for (const tok of tokens) {
      const h = sha256u64(tok)
      for (let i = 0; i < 64; i++) {
        const bit = (h[i < 32 ? 0 : 1]! >> (i % 32)) & 1
        bits[i]! += bit === 1 ? 1 : -1
      }
    }
    let lo = 0, hi = 0
    for (let i = 0; i < 32; i++) if (bits[i]! > 0) lo |= 1 << i
    for (let i = 32; i < 64; i++) if (bits[i]! > 0) hi |= 1 << (i - 32)
    const sig = (BigInt.asUintN(32, BigInt(hi >>> 0)) << 32n) | BigInt.asUintN(32, BigInt(lo >>> 0))
    return { signature: `eh:${req.model}:${sig.toString(16).padStart(16, '0')}` }
  }
}

/** Returns the SHA-256 of `s` as two 32-bit halves [lo, hi] of the first 64 bits. */
function sha256u64(s: string): [number, number] {
  const h = createHash('sha256').update(s).digest()
  const lo = h.readUInt32LE(0)
  const hi = h.readUInt32LE(4)
  return [lo, hi]
}
