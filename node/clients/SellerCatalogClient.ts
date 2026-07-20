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
  public async getProduct(productId: number, userToken?: string): Promise<any> {
    const headers: any = userToken
      ? { VtexIdclientAutCookie: userToken, 'Proxy-Authorization': userToken }
      : {}
    return this.http.get(`/api/catalog-seller-portal/products/${productId}`, { headers })
  }
}
