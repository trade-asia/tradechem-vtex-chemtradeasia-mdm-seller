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

  // License Manager's "Get information about account" — confirmed live
  // schema from VTEX's own OpenAPI file (github.com/vtex/openapi-schemas,
  // "VTEX - License Manager API.json"), unlike the Seller Portal Catalog
  // API elsewhere in this file: { tradingName, companyName, logo, hasLogo,
  // accountName, telephone, cnpj, ... }. Backs the My Products page's
  // company-info ribbon. Per VTEX's docs this needs the "Save account"
  // License Manager resource on whoever's token calls it — the account
  // owner has this by default, but a restricted-role user might not; a
  // 403 here should fail soft (ribbon just omits company info) rather
  // than blocking the page.
  public async getAccountInfo(userToken?: string): Promise<any> {
    return this.http.get('/api/vlm/account', { headers: this.userHeaders(userToken) })
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

  // Confirmed live 2026-10-22 from VTEX's published schema: { data: [{id,
  // name, isActive, ...}], _metadata: {total, from, to, ...} } — paginated
  // by `from`/`to`, defaulting to only the first ~10 if omitted. Also
  // confirmed live: VTEX caps this at 100 entries per request ("Response
  // size can't have more than 100 entries") — a 500 request 400s outright,
  // so this is maxed at the real ceiling, not a margin below it. A seller
  // with over 100 brands would need real pagination here; not the case yet.
  public async listBrands(userToken?: string): Promise<{ items: any[]; raw: any }> {
    const res: any = await this.http.get('/api/catalog-seller-portal/brands?from=1&to=100', { headers: this.userHeaders(userToken) })
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

  // Beta API — schema confirmed 2026-10-22 from VTEX's own published OpenAPI
  // file (github.com/vtex/openapi-schemas, "VTEX - Catalog API Seller
  // Portal.json"), after two rounds of live 400s correcting an earlier
  // guessed flat shape. Required: status, name, brandId, categoryIds
  // (array), specs/attributes/images (arrays, empty is fine), slug, skus
  // (array — this creates the product AND its first SKU in one call, no
  // separate SKU-create endpoint exists in this API family), origin.
  // Builder lives in sellerProductsHandler.ts's saveSellerPriceInventory.
  public async createProduct(payload: any, userToken?: string): Promise<any> {
    return this.http.post('/api/catalog-seller-portal/products', payload, { headers: this.userHeaders(userToken) })
  }

  // Classic Catalog API, not the Seller Portal one — confirmed from VTEX's
  // published schema (github.com/vtex/openapi-schemas, "VTEX - Catalog
  // API.json") that this accepts a plain external image URL directly
  // (VTEX fetches it server-side), unlike the Seller Portal product-create
  // payload's `images` field, which demands an already-vtexassets.com-
  // hosted URL. Same endpoint/shape the marketplace app's own
  // attachSkuImage already uses successfully. Not yet confirmed live
  // whether this classic endpoint works against a SKU created via the
  // newer Seller Portal API — different API family, never tested together
  // before this — so treat this as best-confidence pending the first
  // real attempt, same as everything else new in this file.
  public async attachSkuImage(
    skuId: number,
    url: string,
    name: string,
    isMain: boolean,
    userToken?: string
  ): Promise<any> {
    return this.http.post(
      `/api/catalog/pvt/stockkeepingunit/${skuId}/file`,
      { Name: name, Url: url, IsMain: isMain },
      { headers: this.userHeaders(userToken) }
    )
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
