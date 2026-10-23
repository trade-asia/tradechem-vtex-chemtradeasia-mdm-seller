import { ExternalClient, IOContext, InstanceOptions } from '@vtex/api'

// VTEX's Marketplace Suggestions API — the Received SKUs feature's own API
// surface. Same host/auth shape as the marketplace admin app's own copy of
// this client; only getSuggestion is needed here (2026-10-24: the seller
// app's own "Published" column needs the real offer Status — Pending/
// Processing/Rejected/Approved/Published — not just whether the linked
// VTEX product happens to be Active). Uses the marketplace's own
// vtexAppKey/vtexAppToken, relayed to this app via MDM's shared-config
// endpoint (see devSettingsHandler.ts's readMdmConfig) — the seller
// account itself has no permission to call this API directly.
export class VtexSuggestionsClient extends ExternalClient {
  constructor(ctx: IOContext, options?: InstanceOptions) {
    super(`https://api.vtex.com/${ctx.account}`, ctx, {
      ...options,
      headers: { Accept: 'application/json' },
    })
  }

  private authHeaders(appKey: string, appToken: string) {
    return { 'X-VTEX-API-AppKey': appKey, 'X-VTEX-API-AppToken': appToken }
  }

  // GET /suggestions/{sellerId}/{sellerSkuId} — this seller's own submitted
  // offer for one SKU. Returns null on 404 (no offer submitted, or already
  // resolved and dropped off the queue — the real Status, when present,
  // still distinguishes resolved-but-dropped from genuinely never
  // submitted at the call site).
  public async getSuggestion(appKey: string, appToken: string, sellerId: string, sellerSkuId: string): Promise<any | null> {
    try {
      return await this.http.get(
        `/suggestions/${encodeURIComponent(sellerId)}/${encodeURIComponent(sellerSkuId)}`,
        { headers: this.authHeaders(appKey, appToken) }
      )
    } catch (err: any) {
      if (err?.response?.status === 404) return null
      throw err
    }
  }
}
