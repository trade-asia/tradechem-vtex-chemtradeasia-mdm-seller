import { Clients } from '../clients'

const SELLER_SYNC_BUCKET = 'mdmslr'
const SELLER_SYNC_KEY = 'sync'
// Fallback cadence for the lazy, product-push-triggered path — the touch-
// login endpoint (called from the React pages on mount) bypasses this and
// always force-syncs, since that's the one meant to reflect "the seller
// just opened the app" accurately.
const SELLER_SYNC_REFRESH_MS = 24 * 60 * 60 * 1000

// VTEX user tokens are JWTs — same decode approach as debugAdminTokenHandler.ts.
// first_name/last_name aren't available from this claim; MDM's fields are all
// individually optional, so email-only (or none, for event-triggered syncs
// with no user session) is acceptable here. Real names now come from the
// marketplace app's bulk sync-all-sellers instead (seller-register has them).
export function decodeEmailFromAdminToken(userToken?: string): string | undefined {
  if (!userToken) return undefined
  try {
    const payload = userToken.split('.')[1]
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    return claims?.sub
  } catch {
    return undefined
  }
}

// Unconditionally calls MDM's /vtex/sellers/sync — used by touch-login (an
// admin session on any request to this app's React pages, the closest proxy
// to "the seller logged in" VTEX gives this app) and as the fallback inside
// ensureSellerSynced below. Always updates last_login on MDM's side, since
// that's stamped server-side on every call regardless of what we send.
export async function syncSellerNow(
  ctx: { clients: Clients; vtex: { account: string } },
  mdmToken: string,
  userToken?: string
): Promise<number | null> {
  try {
    const data = await ctx.clients.mdm.syncSeller(mdmToken, {
      vtex_seller_id: ctx.vtex.account,
      email: decodeEmailFromAdminToken(userToken),
    })
    const mdmSellerId = data?.id
    if (mdmSellerId) {
      // Whatever name/logo MDM's own sync response happens to carry (see
      // this function's header comment — names are meant to arrive here via
      // the marketplace app's bulk sync-all-sellers, not anything we send
      // ourselves) — cached alongside mdmSellerId so touch-login can read it
      // back without a second call. Still just a best-confidence guess at
      // field names; "Not defined" on the My Products banner if none of
      // these come back populated is the correct, honest outcome.
      const fullName = [data?.first_name, data?.last_name].filter(Boolean).join(' ')
      const name = data?.name ?? data?.company_name ?? data?.companyName ?? (fullName || undefined)
      const logoUrl = data?.logo ?? data?.logo_url ?? data?.logoUrl ?? data?.picture ?? data?.avatar_url ?? undefined
      await ctx.clients.vbase.saveJSON(SELLER_SYNC_BUCKET, SELLER_SYNC_KEY, {
        mdmSellerId, name, logoUrl, syncedAt: new Date().toISOString(),
      })
      return mdmSellerId
    }
  } catch {}

  let cached: { mdmSellerId: number } | null = null
  try { cached = await ctx.clients.vbase.getJSON<any>(SELLER_SYNC_BUCKET, SELLER_SYNC_KEY, true) } catch {}
  return cached?.mdmSellerId ?? null
}

// Ensures this seller has an MDM seller record before any product push — MDM
// rejects a push with 422 if the seller was never synced via
// POST /vtex/sellers/sync. Cached in VBase rather than called on every
// single capture — this is the lazy path; touch-login (below/handler) is
// the one that always force-syncs on every app open.
export async function ensureSellerSynced(
  ctx: { clients: Clients; vtex: { account: string } },
  mdmToken: string,
  userToken?: string
): Promise<number | null> {
  let cached: { mdmSellerId: number; syncedAt: string } | null = null
  try { cached = await ctx.clients.vbase.getJSON<any>(SELLER_SYNC_BUCKET, SELLER_SYNC_KEY, true) } catch {}

  const isFresh = !!cached && (Date.now() - new Date(cached.syncedAt).getTime()) < SELLER_SYNC_REFRESH_MS
  if (isFresh) return cached!.mdmSellerId

  return syncSellerNow(ctx, mdmToken, userToken)
}

// Reads back whatever syncSellerNow last cached — used by touch-login to
// show name/logo on the My Products banner without a second MDM round trip
// (the force-sync it already does is what populated this).
export async function getCachedSellerInfo(
  ctx: { clients: Clients }
): Promise<{ mdmSellerId?: number; name?: string; logoUrl?: string } | null> {
  try { return await ctx.clients.vbase.getJSON<any>(SELLER_SYNC_BUCKET, SELLER_SYNC_KEY, true) } catch { return null }
}
