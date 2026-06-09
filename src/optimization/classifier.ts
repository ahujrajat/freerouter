import type { ChatRequest, RequestContext } from '../types.js'
import { simhash64 } from './simhash.js'

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

  private classifyByHash(req: ChatRequest): RequestClass {
    const text = req.messages.map(m => m.content).join(' ')
    const hash = simhash64(text)
    if (hash === '0000000000000000') {
      return { signature: `eh:${req.model}:empty` }
    }
    return { signature: `eh:${req.model}:${hash}` }
  }
}
