import axios from 'axios'

// Direct calls from this seller app's own sandbox to the MARKETPLACE
// account's (tradeasiab2b) native VTEX Catalog API — a different host than
// this app's own account, using the VTEX App Key/Token this app already
// fetches via MDM's shared-config relay (devSettingsHandler.ts).
//
// Confirmed live 2026-10-12 (GET /_v/mdm-seller/dev/test-vtex-cross-account,
// account adnnor332 -> tradeasiab2b, 200 OK) that this works: the
// cross-account failure diagnosed on 2026-10-05 was specifically about one
// custom VTEX IO app calling *another custom app's own route*
// (account.myvtex.com/_v/...), which goes through VTEX IO's internal
// app-to-app router and is restricted cross-account. VTEX's native platform
// Catalog API (vtexcommercestable.com.br, authenticated with plain App
// Key/Token headers) is a different, unrestricted path — not gated by that
// same app-to-app restriction. So this app can deactivate the marketplace's
// VTEX product directly; no relay through either MDM or the marketplace app
// is needed for this specific action.
const MARKETPLACE_ACCOUNT = 'tradeasiab2b'

function authHeaders(appKey: string, appToken: string) {
  return { 'X-VTEX-API-AppKey': appKey, 'X-VTEX-API-AppToken': appToken, 'Content-Type': 'application/json' }
}

function baseUrl(): string {
  return `https://${MARKETPLACE_ACCOUNT}.vtexcommercestable.com.br`
}

export async function getMarketplaceVtexProductStatus(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexProductId: string
): Promise<{ success: boolean; isActive?: boolean; name?: string; error?: string }> {
  try {
    const res = await axios.get(`${baseUrl()}/api/catalog/pvt/product/${vtexProductId}`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    return { success: true, isActive: !!res.data?.IsActive, name: res.data?.Name }
  } catch (err: any) {
    const data = err?.response?.data
    const detail = (data?.Message ?? data?.message ?? (typeof data === 'string' ? data : null)) ?? err?.message ?? 'Unknown error'
    return { success: false, error: detail }
  }
}

// Same two-step mechanism as the marketplace app's own
// node/helpers/deactivateVtexProduct.ts (deactivate every SKU, then the
// product itself) — reimplemented here with raw axios against a hardcoded
// tradeasiab2b host rather than ctx.vtex.account, since this app's own
// running account is always the seller's, never the marketplace's.
export async function deactivateMarketplaceVtexProduct(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexProductId: string
): Promise<{ success: boolean; error?: string; detail?: string }> {
  const headers = authHeaders(vtexAppKey, vtexAppToken)

  try {
    const skus = await axios.get(
      `${baseUrl()}/api/catalog_system/pvt/sku/stockkeepingunitByProductId/${vtexProductId}`,
      { headers, timeout: 15000 }
    )
    const skuList = Array.isArray(skus.data) ? skus.data : []
    for (const sku of skuList) {
      try {
        await axios.put(
          `${baseUrl()}/api/catalog/pvt/stockkeepingunit/${sku.Id}`,
          { ...sku, IsActive: false },
          { headers, timeout: 15000 }
        )
      } catch {}
    }
  } catch {}

  try {
    const product = await axios.get(`${baseUrl()}/api/catalog/pvt/product/${vtexProductId}`, { headers, timeout: 15000 })
    await axios.put(
      `${baseUrl()}/api/catalog/pvt/product/${vtexProductId}`,
      { ...product.data, IsActive: false, IsVisible: false },
      { headers, timeout: 15000 }
    )
    return { success: true }
  } catch (err: any) {
    const data = err?.response?.data
    const detail = (data?.Message ?? data?.message ?? (typeof data === 'string' ? data : null)) ?? err?.message ?? 'Unknown error'
    return { success: false, error: 'Failed to deactivate VTEX product', detail }
  }
}
