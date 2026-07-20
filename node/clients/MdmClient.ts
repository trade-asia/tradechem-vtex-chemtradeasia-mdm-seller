import { ExternalClient, InstanceOptions, IOContext } from '@vtex/api'

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

  private url(path: string): string {
    return `${this.mdmBaseUrl}${path}`
  }
}
