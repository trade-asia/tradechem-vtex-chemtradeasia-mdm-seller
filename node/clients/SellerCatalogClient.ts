import { ExternalClient, IOContext, InstanceOptions } from '@vtex/api'

// Seller Portal accounts use the Seller Portal Catalog API (not the classic
// catalog API). Authenticated with the app's own token — no per-seller keys.
export class SellerCatalogClient extends ExternalClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(`http://${context.account}.vtexcommercestable.com.br`, context, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Proxy-Authorization': context.authToken,
        VtexIdclientAutCookie: context.authToken,
        'X-Vtex-Use-Https': 'true',
      },
      timeout: 8000,
    })
  }

  // userToken: the logged-in admin/seller user's token (ctx.vtex.adminUserAuthToken)
  // — the Seller Portal Catalog API rejects app tokens for product-read, but
  // accepts the account user who owns the catalog. Falls back to the app token
  // (events have no user context).
  private userHeaders(userToken?: string) {
    return userToken ? { VtexIdclientAutCookie: userToken, 'Proxy-Authorization': userToken } : {}
  }

  public async getProduct(productId: number, userToken?: string): Promise<any> {
    return this.http.get(`/api/catalog-seller-portal/products/${productId}`, { headers: this.userHeaders(userToken) })
  }

  // Beta API, unconfirmed response shape (see createProduct's own note) —
  // tries every plausible wrapper rather than assuming one, and hands the
  // raw response back alongside whatever got parsed so the handler can
  // surface it as a diagnostic instead of silently showing an empty
  // dropdown when the seller's account actually has brands/categories.
  private extractList(res: any, keys: string[]): any[] {
    if (Array.isArray(res)) return res
    for (const key of keys) {
      if (Array.isArray(res?.[key])) return res[key]
    }
    return []
  }

  public async listBrands(userToken?: string): Promise<{ items: any[]; raw: any }> {
    const res: any = await this.http.get('/api/catalog-seller-portal/brands', { headers: this.userHeaders(userToken) })
    return { items: this.extractList(res, ['data', 'items', 'Items', 'brands', 'Brands', 'result']), raw: res }
  }

  // Confirmed live 2026-10-22: wrapped as { roots: [{ value: {id, name,
  // isActive}, children: [...] }], createdAt, updatedAt } — each node's own
  // id/name sit under .value, not at the node's top level. The handler's
  // tree-walk knows this shape specifically now; items here is just the
  // roots array for it to walk.
  public async getCategoryTree(userToken?: string): Promise<{ items: any[]; raw: any }> {
    const res: any = await this.http.get('/api/catalog-seller-portal/category-tree', { headers: this.userHeaders(userToken) })
    const items = Array.isArray(res?.roots) ? res.roots : this.extractList(res, ['data', 'items', 'Items', 'categories', 'Categories', 'result'])
    return { items, raw: res }
  }

  // Beta API, no published request/response schema we could retrieve (see
  // sellerProductsHandler.ts's own note) — field names are a best-confidence
  // guess following the classic Catalog API's own conventions (Name,
  // BrandId, CategoryId, RefId, PackagedWeightKg/Width/Height/Length), on
  // the theory that this is a thin layer over the same underlying VTEX
  // product/SKU model. Creates product AND its first SKU in one call — no
  // separate SKU-create endpoint exists in this API family at all. To be
  // corrected against the raw response/error on the first live attempt.
  public async createProduct(payload: any, userToken?: string): Promise<any> {
    return this.http.post('/api/catalog-seller-portal/products', payload, { headers: this.userHeaders(userToken) })
  }

  public async listWarehouses(userToken?: string): Promise<any[]> {
    const res: any = await this.http.get('/api/logistics/pvt/configuration/warehouses', { headers: this.userHeaders(userToken) })
    return Array.isArray(res) ? res : []
  }

  public async setInventory(
    skuId: number,
    warehouseId: string,
    quantity: number,
    unlimitedQuantity: boolean,
    userToken?: string
  ): Promise<any> {
    return this.http.put(
      `/api/logistics/pvt/inventory/skus/${skuId}/warehouses/${warehouseId}`,
      { quantity, unlimitedQuantity, dateUtcOnBalanceSystem: new Date().toISOString() },
      { headers: this.userHeaders(userToken) }
    )
  }
}
