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

// Pricing lives on a different host entirely (api.vtex.com, scoped by
// account name in the path) — same split the marketplace app's own
// VtexPricingClient.ts documents, confirmed against VTEX's docs.
function pricingBaseUrl(): string {
  return `https://api.vtex.com/${MARKETPLACE_ACCOUNT}`
}

// Export columns (2026-10-20, at the seller's request) — the exact same
// VTEX-side fields the marketplace admin's Import/Link-to-SKU tabs already
// show (see the marketplace app's getImportExistingDetails), fetched here
// read-only via the same cross-account mechanism as the two functions
// above. SKU id comes from MDM's own vtex_sku_id when it has one; falls
// back to "first SKU of this product" otherwise (MDM's read side doesn't
// echo vtex_sku_id back yet for every row — see SellerProducts.js's own
// comment on that gap).
export async function getMarketplaceSkusByProductId(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexProductId: string
): Promise<any[]> {
  try {
    const res = await axios.get(
      `${baseUrl()}/api/catalog_system/pvt/sku/stockkeepingunitByProductId/${vtexProductId}`,
      { headers: authHeaders(vtexAppKey, vtexAppToken), timeout: 15000 }
    )
    return Array.isArray(res.data) ? res.data : []
  } catch {
    return []
  }
}

export async function getMarketplaceProduct(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexProductId: string
): Promise<any | null> {
  try {
    const res = await axios.get(`${baseUrl()}/api/catalog/pvt/product/${vtexProductId}`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    return res.data
  } catch {
    return null
  }
}

export async function getMarketplaceSku(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexSkuId: number
): Promise<any | null> {
  try {
    const res = await axios.get(`${baseUrl()}/api/catalog/pvt/stockkeepingunit/${vtexSkuId}`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    return res.data
  } catch {
    return null
  }
}

export async function getMarketplacePrice(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexSkuId: number
): Promise<any | null> {
  try {
    const res = await axios.get(`${pricingBaseUrl()}/pricing/prices/${vtexSkuId}`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    return res.data
  } catch {
    return null
  }
}

export async function getMarketplaceInventory(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexSkuId: number
): Promise<any[]> {
  try {
    const res = await axios.get(`${baseUrl()}/api/logistics/pvt/inventory/skus/${vtexSkuId}`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    return Array.isArray(res.data?.balance) ? res.data.balance : []
  } catch {
    return []
  }
}

// Name-resolution maps, fetched once per export run rather than per row —
// Category/Brand/Warehouse are IDs on the product/SKU/inventory records
// above, and a CSV is far more useful to a human with the actual names.
export async function getMarketplaceCategoryMap(
  vtexAppKey: string,
  vtexAppToken: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const res = await axios.get(`${baseUrl()}/api/catalog_system/pub/category/tree/10`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    const walk = (nodes: any[]) => {
      for (const node of nodes ?? []) {
        if (node?.id != null) map.set(String(node.id), node.name)
        if (Array.isArray(node?.children)) walk(node.children)
      }
    }
    walk(res.data)
  } catch {}
  return map
}

export async function getMarketplaceBrandMap(
  vtexAppKey: string,
  vtexAppToken: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const res = await axios.get(`${baseUrl()}/api/catalog_system/pvt/brand/list`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    for (const b of res.data ?? []) {
      if (b?.id != null) map.set(String(b.id), b.name)
    }
  } catch {}
  return map
}

export async function getMarketplaceWarehouseMap(
  vtexAppKey: string,
  vtexAppToken: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const res = await axios.get(`${baseUrl()}/api/logistics/pvt/configuration/warehouses`, {
      headers: authHeaders(vtexAppKey, vtexAppToken),
      timeout: 15000,
    })
    for (const w of res.data ?? []) {
      if (w?.id != null) map.set(String(w.id), w.name)
    }
  } catch {}
  return map
}

// Price & Inventory self-service (2026-10-22, at the seller's request) —
// writes directly to the marketplace's VTEX catalog, same mechanism/shape
// as the marketplace app's own VtexPricingClient.setPrice /
// VtexSearchClient.setSkuInventory, just called cross-account here. Each
// save also gets mirrored into MDM's new metadata endpoint (see
// sellerProductsHandler.ts) so the admin panel's Metadata tab shows what
// was last pushed — VTEX stays the actual source of truth for price/stock,
// MDM's copy is read-only visibility only.
const FALLBACK_TRADE_POLICY_IDS = ['1', '2']

export async function setMarketplacePrice(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexSkuId: number,
  price: number,
  listPrice?: number,
  tradePolicyIds: string[] = FALLBACK_TRADE_POLICY_IDS
): Promise<{ success: boolean; error?: string }> {
  try {
    await axios.put(
      `${pricingBaseUrl()}/pricing/prices/${vtexSkuId}`,
      {
        costPrice: price,
        markup: 0,
        listPrice: listPrice || undefined,
        fixedPrices: tradePolicyIds.map(tradePolicyId => ({
          tradePolicyId, value: price, listPrice: listPrice || undefined, minQuantity: 1,
        })),
      },
      { headers: authHeaders(vtexAppKey, vtexAppToken), timeout: 15000 }
    )
    return { success: true }
  } catch (err: any) {
    const data = err?.response?.data
    const detail = (data?.Message ?? data?.message ?? (typeof data === 'string' ? data : null)) ?? err?.message ?? 'Unknown error'
    return { success: false, error: detail }
  }
}

export async function setMarketplaceInventory(
  vtexAppKey: string,
  vtexAppToken: string,
  vtexSkuId: number,
  warehouseId: string,
  quantity: number,
  unlimitedQuantity: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    await axios.put(
      `${baseUrl()}/api/logistics/pvt/inventory/skus/${vtexSkuId}/warehouses/${warehouseId}`,
      { quantity, unlimitedQuantity, dateUtcOnBalanceSystem: new Date().toISOString() },
      { headers: authHeaders(vtexAppKey, vtexAppToken), timeout: 15000 }
    )
    return { success: true }
  } catch (err: any) {
    const data = err?.response?.data
    const detail = (data?.Message ?? data?.message ?? (typeof data === 'string' ? data : null)) ?? err?.message ?? 'Unknown error'
    return { success: false, error: detail }
  }
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
