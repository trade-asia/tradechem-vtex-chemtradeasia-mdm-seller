import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'

// GET /_v/mdm-seller/account — this seller's own VTEX account info (name,
// trade name, address, logo, etc.), sourced straight from VTEX's own
// License Manager (ctx.vtex.account is this seller's own account, since this
// app is installed per-seller — no marketplace credentials needed).
//
// getAccountData needs a real logged-in admin session (VtexIdclientAutCookie)
// — same requirement as debugAdminTokenHandler.ts. It's always absent over
// curl; open this route in a browser tab logged into this seller's admin.
// Falls back to the app's own authToken on the off chance License Manager
// accepts it too, but that's unconfirmed — the primary path is the user
// token.
export async function getSellerAccount(ctx: ServiceContext<Clients>) {
  ctx.status = 200

  const userToken: string | undefined = (ctx.vtex as any)?.adminUserAuthToken
  const appToken: string | undefined = (ctx.vtex as any)?.authToken
  const token = userToken ?? appToken

  if (!token) {
    ctx.body = {
      success: false,
      error: 'No VTEX auth token on this request — open this URL in a browser tab logged into this seller’s admin.',
    }
    return
  }

  try {
    const raw: any = await ctx.clients.licenseManager.getAccountData(token)
    ctx.body = {
      success: true,
      account: {
        id: raw?.Id ?? ctx.vtex.account,
        name: raw?.AccountName ?? raw?.Name ?? null,
        tradeName: raw?.TradeName ?? null,
        email: raw?.AccountEmail ?? raw?.Email ?? null,
        logoUrl: raw?.LogoUrl ?? raw?.Logo ?? null,
        address: raw?.Address ?? null,
        phone: raw?.Phone ?? null,
        isActive: raw?.IsActive ?? null,
      },
      // Full untouched response — field names above are best-effort until
      // verified live against this account; nothing is lost if some don't
      // match.
      raw,
    }
  } catch (err: any) {
    ctx.body = {
      success: false,
      error: 'Failed to load account data from VTEX',
      detail: err?.response?.data ?? err?.message,
    }
  }
}
