import type { PricingManifest, PricingSource } from 'freerouter'

export interface PricingFetcher {
  fetch(source: string): Promise<PricingManifest>
}

export type SourceFactory = () => PricingSource

/** Fetches pricing via injectable source factories (real ones wrap freerouter's
 *  liteLLMPricingSource/openRouterPricingSource; tests inject fakes). */
export class LibraryPricingFetcher implements PricingFetcher {
  constructor(private readonly sources: Record<string, SourceFactory>) {}
  async fetch(source: string): Promise<PricingManifest> {
    const factory = this.sources[source]
    if (factory === undefined) throw new Error(`[pricing] unknown pricing source: ${source}`)
    return factory().fetch()
  }
}
