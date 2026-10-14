import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { getSellerMdmToken } from './devSettingsHandler'
import { syncSellerNow, decodeEmailFromAdminToken } from '../helpers/sellerSync'

// GET /_v/mdm-seller/touch-login — called by the React admin pages once on
// mount. VTEX gives this app no real "seller logged in" webhook, so an admin
// session existing on a request to one of this app's own pages is the
// closest honest proxy available. Always force-syncs (unlike the lazy,
// 24h-cached ensureSellerSynced used before a product push) so last_login
// genuinely reflects this visit rather than a stale cached one.
export async function touchSellerLogin(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const userToken: string | undefined = (ctx.vtex as any)?.adminUserAuthToken
  if (!userToken) {
    ctx.body = { success: false, error: 'no_admin_session' }
    return
  }

  const token = await getSellerMdmToken(ctx)
  if (!token) {
    ctx.body = { success: false, error: 'MDM credentials/token not configured' }
    return
  }

  const mdmSellerId = await syncSellerNow(ctx as any, token, userToken)
  ctx.body = {
    success: !!mdmSellerId,
    mdmSellerId,
    // Shown in a banner on the seller's own "My Products" page so a stale
    // seller/MDM-id mismatch (like the constellationgroups411 incident) is
    // visible at a glance, right from this always-fresh sync — not read
    // back from a cache that could itself be the thing that's stale.
    vtexAccount: ctx.vtex.account,
    email: decodeEmailFromAdminToken(userToken),
    syncedAt: new Date().toISOString(),
  }
}
