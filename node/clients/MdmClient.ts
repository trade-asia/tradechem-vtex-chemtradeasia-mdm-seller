import { ExternalClient, InstanceOptions, IOContext, CacheType } from '@vtex/api'

const DEFAULT_BASE_URL = 'https://tradeasia.exchange/api/v1'

interface TokenResponse {
  success: boolean
  data: { token: string; expires_at: string }
}

interface ProductsResponse {
  success: boolean
  data: any[]
  meta: {
    current_page: number
    last_page: number
    per_page: number
    total: number
  }
}

interface ProductFilters {
  name?: string
  sku?: string
  cas_number?: string
}

export class MdmClient extends ExternalClient {
  private mdmBaseUrl: string = DEFAULT_BASE_URL

  constructor(ctx: IOContext, options?: InstanceOptions) {
    super(DEFAULT_BASE_URL, ctx, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    })
  }

  public setBaseUrl(url: string): void {
    this.mdmBaseUrl = url ? url.replace(/\/$/, '') : DEFAULT_BASE_URL
  }

  public getBaseUrl(): string {
    return this.mdmBaseUrl
  }

  public async authenticate(
    email: string,
    password: string
  ): Promise<{ token: string; expiresAt: string }> {
    const res: TokenResponse = await this.http.post(this.url('/user/token'), { email, password })
    return { token: res.data.token, expiresAt: res.data.expires_at }
  }

  // Linked products only, scoped to this seller — MDM returns only products
  // whose link row carries the given vtex_seller_id (API Gap 1)
  public async getLinkedProducts(
    token: string,
    vtexSellerId: string,
    page = 1,
    perPage = 20,
    filters?: ProductFilters
  ): Promise<{ products: any[]; currentPage: number; lastPage: number; total: number }> {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      vtex_linked: '1',
      vtex_seller_id: vtexSellerId,
    })
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && val !== '') params.set(key, val)
      }
    }

    const res: ProductsResponse = await this.http.get(
      this.url(`/vtex/products?${params.toString()}`),
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return {
      products: Array.isArray(res.data) ? res.data : [],
      currentPage: res.meta?.current_page ?? page,
      lastPage: res.meta?.last_page ?? 1,
      total: res.meta?.total ?? 0,
    }
  }

  // POST /vtex/products — with a seller token the scope is bound server-side;
  // vtex_seller_id in the payload must match (or be used by admin-cred fallback)
  public async upsertProduct(token: string, payload: any): Promise<any> {
    const res: any = await this.http.post(this.url('/vtex/products'), payload, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res?.data ?? res
  }

  public async getCountries(token: string): Promise<any[]> {
    const res: any = await this.http.get(this.url('/config/countries'), {
      headers: { Authorization: `Bearer ${token}` },
    })
    return Array.isArray(res.data) ? res.data : []
  }

  // Always seller-scoped: MDM returns only this seller's documents
  public async listSellerDocuments(
    token: string,
    vtexProductId: string,
    vtexSellerId: string
  ): Promise<any[]> {
    const res: any = await this.http.get(
      this.url(`/vtex/products/${vtexProductId}/documents?vtex_seller_id=${encodeURIComponent(vtexSellerId)}`),
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return Array.isArray(res.data) ? res.data : []
  }

  // Seller id in the body — MDM enforces the seller may only delete their own
  public async deleteSellerDocument(
    token: string,
    documentId: number,
    vtexSellerId: string
  ): Promise<void> {
    await this.http.delete(this.url(`/vtex/documents/${documentId}`), {
      headers: { Authorization: `Bearer ${token}` },
      data: { vtex_seller_id: vtexSellerId },
    } as any)
  }

  // MDM Subscriptions module — see docs/vtex-subscriptions-integration-guide.html
  // (MDM repo). MDM never talks to Stripe itself; this is read-only lookups
  // against MDM's system of record.
  //
  // cacheable: CacheType.None on all three — @vtex/api's HTTP client caches
  // GET responses by URL only (headers, including Authorization, aren't part
  // of the cache key). These URLs are otherwise static per seller, so the
  // very first response (e.g. a 401 while a token was still being sorted
  // out) would get cached and silently served back forever regardless of
  // which token is sent on later calls — confirmed live: a manual curl with
  // a known-good fresh token succeeded while this client kept returning a
  // stale cached "Unauthenticated." for the same URL.
  public async getSubscriptionPlans(token: string): Promise<any[]> {
    const res: any = await this.http.get(this.url('/subscriptions/plans?source=vtex'), {
      headers: { Authorization: `Bearer ${token}` },
      cacheable: CacheType.None,
    } as any)
    if (Array.isArray(res)) return res
    if (Array.isArray(res?.data)) return res.data
    return []
  }

  // externalReferenceId = the VTEX Seller ID (currently ctx.vtex.account —
  // needs confirming with the MDM team as the definitive value). Returns the
  // first matching subscription, or null if this seller has none yet.
  public async getSubscription(token: string, externalReferenceId: string): Promise<any | null> {
    const res: any = await this.http.get(
      this.url(`/subscriptions?source=vtex&external_reference_id=${encodeURIComponent(externalReferenceId)}`),
      { headers: { Authorization: `Bearer ${token}` }, cacheable: CacheType.None } as any
    )
    const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    return list[0] ?? null
  }

  public async getSubscriptionInvoices(token: string, externalReferenceId: string): Promise<any[]> {
    const res: any = await this.http.get(
      this.url(`/subscriptions/invoices?source=vtex&external_reference_id=${encodeURIComponent(externalReferenceId)}`),
      { headers: { Authorization: `Bearer ${token}` }, cacheable: CacheType.None } as any
    )
    return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
  }

  // The single ingestion endpoint MDM's guide describes — this is what
  // actually creates the subscription record in MDM. Called synchronously
  // right after we create the Stripe Subscription (real checkout) so MDM's
  // own Stripe webhook (a separate, direct Stripe -> MDM path — see
  // docs/vtex-subscriptions-integration-guide.html) has an existing record
  // to update from that point on; MDM never creates one from a bare webhook
  // event alone since it needs plan_id, which only we know at creation time.
  public async reportSubscriptionEvent(token: string, payload: any): Promise<any> {
    const res: any = await this.http.post(this.url('/subscriptions/events'), payload, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res?.data ?? res
  }

  // Cancels at period end (cancel_at_period_end=true on Stripe), not
  // immediately — access continues until the paid period ends. Synchronous:
  // MDM calls Stripe and updates its own cancel_at before responding, so the
  // response is already final for display, no webhook wait needed. Status
  // stays whatever it already was (active/past_due/etc) — it only flips to
  // "canceled" for real later, once MDM's own Stripe webhook receives
  // customer.subscription.deleted at the actual period end. Idempotent —
  // safe to call again if already scheduled.
  public async cancelSubscription(token: string, externalReferenceId: string): Promise<any> {
    const res: any = await this.http.post(
      this.url('/subscriptions/cancel'),
      { source: 'vtex', external_reference_id: externalReferenceId },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return res?.data ?? res
  }

  private url(path: string): string {
    return `${this.mdmBaseUrl}${path}`
  }
}
