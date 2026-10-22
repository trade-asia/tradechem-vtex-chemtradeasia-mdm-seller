import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { getSellerMdmToken } from './devSettingsHandler'
import { syncSellerNow, decodeEmailFromAdminToken, getCachedSellerInfo } from '../helpers/sellerSync'

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
  const cachedSellerInfo = await getCachedSellerInfo(ctx as any)

  // Best-effort, separate from the MDM sync above — a 403 (missing License
  // Manager permission on this user) or any other failure here shouldn't
  // block the page or the MDM sync result, it just means the ribbon shows
  // without company info.
  let companyName: string | undefined
  let logoUrl: string | undefined
  try {
    const account = await ctx.clients.sellerCatalog.getAccountInfo(userToken)
    companyName = account?.tradingName || account?.companyName || undefined
    logoUrl = account?.hasLogo && account?.logo ? account.logo : undefined
  } catch {}

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
    // Seller name/logo: whatever MDM's sync response happened to carry
    // (see sellerSync.ts — unconfirmed field names, "Not defined" on the
    // frontend if neither of these came back populated).
    sellerName: cachedSellerInfo?.name,
    sellerLogoUrl: cachedSellerInfo?.logoUrl,
    // Company name/logo: VTEX's own account-level Company Information
    // (License Manager), confirmed schema — distinct from the seller-name
    // fields above, which come from MDM instead.
    companyName,
    logoUrl,
  }
}
