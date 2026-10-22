import { ExternalClient, IOContext, InstanceOptions } from '@vtex/api'

// Same split as the marketplace app's own VtexPricingClient.ts documents —
// Pricing lives on api.vtex.com (scoped by account in the path), not
// {account}.vtexcommercestable.com.br like the rest of the Catalog API.
// Same-account, session-token auth as SellerCatalogClient — see that
// file's own comment on why an app token alone isn't accepted here.
export class SellerPricingClient extends ExternalClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(`https://api.vtex.com/${context.account}`, context, {
      ...options,
      headers: {
        Accept: 'application/vnd.vtex.pricing.v3+json',
        'Content-Type': 'application/json',
        'Proxy-Authorization': context.authToken,
        VtexIdclientAutCookie: context.authToken,
      },
      timeout: 8000,
    })
  }

  private userHeaders(userToken?: string) {
    return userToken ? { VtexIdclientAutCookie: userToken, 'Proxy-Authorization': userToken } : {}
  }

  // No fixedPrices-per-trade-policy loop here (unlike the marketplace app's
  // cross-account price writes) — a seller's own fresh Seller Portal
  // account has a single default trade policy, not the marketplace's
  // multi-channel setup, so basePrice alone is enough. Revisit if a seller
  // account turns out to have more than one sales channel.
  public async setPrice(
    skuId: number,
    price: number,
    listPrice?: number,
    userToken?: string
  ): Promise<any> {
    return this.http.put(
      `/pricing/prices/${skuId}`,
      { costPrice: price, markup: 0, listPrice: listPrice || undefined },
      { headers: this.userHeaders(userToken) }
    )
  }
}
