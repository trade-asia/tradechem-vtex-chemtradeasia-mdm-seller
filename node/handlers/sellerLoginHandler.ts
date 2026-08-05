import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { getSellerMdmToken } from './devSettingsHandler'
import { syncSellerNow } from '../helpers/sellerSync'

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
  ctx.body = { success: !!mdmSellerId, mdmSellerId }
}
