import { ExternalClient, InstanceOptions, IOContext } from '@vtex/api'

const BASE_URL = 'https://tradeasiab2b.myvtex.com'

// Talks to the marketplace app (tradechem-vtex-chemtradeasia-mdm) for the
// one cross-account call this app needs: pulling shared MDM/Stripe settings
// when nothing's configured locally yet. Previously a raw axios.get() in
// devSettingsHandler.ts — that failed consistently with "Client network
// socket disconnected before secure TLS connection was established" for any
// seller account with nothing cached (confirmed live via a diag trace,
// 2026-10-05), while every other cross-service call in this app (MdmClient,
// SellerCatalogClient) already goes through @vtex/api's ExternalClient and
// has never shown this failure. Routing through ExternalClient here too,
// since that's the HTTP path VTEX IO's sandbox actually supports reliably.
export class MarketplaceAppClient extends ExternalClient {
  constructor(ctx: IOContext, options?: InstanceOptions) {
    super(BASE_URL, ctx, {
      ...options,
      headers: { Accept: 'application/json' },
    })
  }

  public async getGlobalSettings(secret: string): Promise<any> {
    return this.http.get('/_v/chemtradeasia-mdm/global-settings', {
      headers: { 'x-global-settings-secret': secret },
    })
  }
}
