import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'

// GET /_v/mdm-seller/debug-admin-token — shows whether this request carries a
// logged-in admin user token (the credential used for Seller Portal catalog
// reads) and its expiry. Never echoes the token itself. Open it in a browser
// tab where you're logged into this account's admin — via curl it will always
// report "absent" since curl sends no session cookie.
export async function debugAdminToken(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const token: string | undefined = (ctx.vtex as any)?.adminUserAuthToken

  if (!token) {
    ctx.body = {
      adminUserToken: 'absent',
      hint: 'No admin session on this request. Open this URL in a browser tab logged into this account’s admin (curl has no session cookie). Catalog captures will fall back to the app token, which the Seller Portal API rejects with 403 product-read.',
      appTokenPresent: !!(ctx.vtex as any)?.authToken,
    }
    return
  }

  // VTEX user tokens are JWTs — decode the payload (no verification needed,
  // this is a local diagnostic) to report expiry and identity.
  let claims: any = null
  try {
    const payload = token.split('.')[1]
    claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {}

  const expMs = claims?.exp ? claims.exp * 1000 : null
  const remainingMin = expMs ? Math.round((expMs - Date.now()) / 60000) : null

  ctx.body = {
    adminUserToken: 'present',
    tokenLength: token.length,
    account: claims?.account ?? null,
    user: claims?.sub ?? null,
    issuedAt: claims?.iat ? new Date(claims.iat * 1000).toISOString() : null,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    remainingMinutes: remainingMin,
    expired: remainingMin !== null ? remainingMin <= 0 : null,
    hint: remainingMin !== null && remainingMin <= 5
      ? 'Token expires very soon — refresh the admin page before running captures.'
      : 'Token is what /capture uses for Seller Portal catalog reads.',
  }
}
