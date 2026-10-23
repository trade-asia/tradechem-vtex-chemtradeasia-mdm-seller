import { ServiceContext } from '@vtex/api'
import axios from 'axios'
import { Clients } from '../clients'
import { getMdmToken, clearMdmToken } from '../helpers/getMdmToken'
import { ensureSellerSynced } from '../helpers/sellerSync'
import { readMdmConfig, forceRefreshMdmConfig } from './devSettingsHandler'
import { readBody } from '../helpers/readBody'
import {
  deactivateMarketplaceVtexProduct,
  getMarketplaceVtexProductStatus,
  getMarketplaceProduct,
  getMarketplaceSku,
  getMarketplaceSkusByProductId,
  getMarketplacePrice,
  getMarketplaceInventory,
  getMarketplaceCategoryMap,
  getMarketplaceBrandMap,
  getMarketplaceWarehouseMap,
} from '../helpers/marketplaceVtexClient'

async function readSettings(ctx: ServiceContext<Clients>): Promise<any | null> {
  const settings = await readMdmConfig(ctx)

  const { mdmUsername, mdmPassword } = settings
  if (!mdmUsername || !mdmPassword) {
    ctx.status = 200
    ctx.body = {
      success: false,
      error: `MDM credentials not configured in app settings. [diag: ${JSON.stringify(settings._diag ?? 'MISSING')}]`,
    }
    return null
  }
  if (settings.mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(settings.mdmApiEndpoint)
  return settings
}

// Linked products the seller can attach documents to — backs the Documents
// section's product picker search. Deliberately separate from
// listSellerProducts below (the new Products section's own full list):
// this one is vtex_linked=1-only, keyed by vtex_seller_id, with its own
// 401-retry-with-fresh-token logic; the two have never been the same thing
// despite the similar name.
export async function getSellerProducts(ctx: ServiceContext<Clients>) {
  const settings = await readSettings(ctx)
  if (!settings) return

  const q = ctx.query as Record<string, string>
  const page = parseInt(q.page ?? '1', 10)
  const perPage = parseInt(q.per_page ?? '20', 10)
  const filters = {
    name: q.name || undefined,
    sku: q.sku || undefined,
    cas_number: q.cas_number || undefined,
  }

  try {
    const token = await getMdmToken(ctx, settings.mdmUsername, settings.mdmPassword)
    const result = await ctx.clients.mdm.getLinkedProducts(token, ctx.vtex.account, page, perPage, filters)
    ctx.status = 200
    ctx.body = { success: true, ...result }
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.message?.includes('401')) {
      try {
        await clearMdmToken(ctx)
        const freshToken = await getMdmToken(ctx, settings.mdmUsername, settings.mdmPassword, true)
        const result = await ctx.clients.mdm.getLinkedProducts(freshToken, ctx.vtex.account, page, perPage, filters)
        ctx.status = 200
        ctx.body = { success: true, ...result }
        return
      } catch (retryErr: any) {
        ctx.status = 200
        ctx.body = { success: false, error: 'MDM authentication failed.', detail: retryErr.message }
        return
      }
    }
    ctx.status = 200
    ctx.body = { success: false, error: 'Failed to fetch products from MDM', detail: err.message }
  }
}

export async function getSellerCountries(ctx: ServiceContext<Clients>) {
  const settings = await readSettings(ctx)
  if (!settings) return

  try {
    const token = await getMdmToken(ctx, settings.mdmUsername, settings.mdmPassword)
    const countries = await ctx.clients.mdm.getCountries(token)
    ctx.status = 200
    ctx.body = { success: true, countries }
  } catch (err: any) {
    ctx.status = 200
    ctx.body = { success: false, error: 'Failed to fetch countries', detail: err.message }
  }
}

// MDM response envelope: { success, statusCode, message, data, errors } —
// same shape/handling as sellerDocumentsHandler.ts's mdmErrDetail.
function mdmErrDetail(err: any): string {
  const data = err?.response?.data
  if (!data) return err?.message ?? 'Unknown error'
  if (typeof data === 'string') return data
  if (data.errors && typeof data.errors === 'object') {
    const msgs = (Object.values(data.errors) as any[]).flat().filter(m => typeof m === 'string')
    if (msgs.length) return msgs.join('; ')
  }
  if (data.message) return data.message
  try { return JSON.stringify(data) } catch { return err.message }
}

// VTEX's raw error shape (same pattern as the marketplace app's own
// importStepsHandler.ts) — used for the Seller Catalog/Pricing/Logistics
// calls above, which are a separate error family from MDM's own.
function vtexErrDetail(err: any): string {
  const status = err?.response?.status
  const prefix = status ? `HTTP ${status}: ` : ''
  const data = err?.response?.data
  if (!data) return `${prefix}${err?.message ?? 'no response body from VTEX'}`
  if (typeof data === 'string') return `${prefix}${data.slice(0, 300)}`
  if (data.Message) return `${prefix}${data.Message}`
  if (data.message) return `${prefix}${data.message}`
  if (data.error) return `${prefix}${data.error}`
  try { return `${prefix}${JSON.stringify(data)}` } catch { return `${prefix}${err.message}` }
}

interface MdmAuth {
  token: string
  baseUrl: string
  vtexSellerId: string
  mdmSellerId: number
}

// Every endpoint here needs MDM's own numeric seller id (mdm_seller_id), not
// just the VTEX account — resolved via the same ensureSellerSynced() cache
// used before any product push elsewhere in this app (24h-cached, force-
// synced on touch-login). A seller who's never synced gets a clear error
// here instead of a confusing 422 from MDM.
async function mdmAuth(ctx: ServiceContext<Clients>): Promise<MdmAuth | null> {
  const settings = await readMdmConfig(ctx)
  let { mdmApiEndpoint, mdmUsername, mdmPassword } = settings
  if (!mdmUsername || !mdmPassword) {
    ctx.body = {
      success: false,
      error: `MDM credentials not configured in app settings. [diag: ${JSON.stringify(settings._diag ?? 'MISSING')}]`,
    }
    return null
  }
  if (mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(mdmApiEndpoint)

  let token: string
  try {
    token = await getMdmToken(ctx, mdmUsername, mdmPassword)
  } catch (err: any) {
    // Covers both an expired cached token and a password rotated on MDM's
    // side — readMdmConfig()'s cache only guards against fields being
    // missing, not against a cached password simply going stale, so a
    // rotation otherwise keeps failing with "Unauthenticated." forever
    // until someone clears the cache by hand. Re-fetch fresh from MDM's
    // shared-config relay and force one new login before giving up.
    await clearMdmToken(ctx)
    const fresh = await forceRefreshMdmConfig(ctx)
    if (!fresh?.mdmUsername || !fresh?.mdmPassword) {
      ctx.body = { success: false, error: 'MDM authentication failed.', detail: err?.message }
      return null
    }
    mdmUsername = fresh.mdmUsername
    mdmPassword = fresh.mdmPassword
    if (fresh.mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(fresh.mdmApiEndpoint)
    try {
      token = await getMdmToken(ctx, mdmUsername, mdmPassword, true)
    } catch (retryErr: any) {
      ctx.body = { success: false, error: 'MDM authentication failed.', detail: retryErr?.message }
      return null
    }
  }

  const userToken: string | undefined = (ctx.vtex as any)?.adminUserAuthToken
  const mdmSellerId = await ensureSellerSynced(ctx as any, token, userToken)
  if (!mdmSellerId) {
    ctx.body = { success: false, error: 'Could not sync this seller with MDM yet — try reloading the page.' }
    return null
  }

  return { token, baseUrl: ctx.clients.mdm.getBaseUrl(), vtexSellerId: ctx.vtex.account, mdmSellerId }
}

function looksLikeAuthFailure(err: any): boolean {
  if (err?.response?.status === 401) return true
  const msg = String(err?.response?.data?.message ?? err?.message ?? '')
  return /unauthenticated/i.test(msg)
}

// The gap mdmAuth()'s own try/catch doesn't cover: a token that was already
// cached (so getMdmToken returned it without ever calling MDM) can still be
// dead — MDM revokes outstanding tokens the moment a password rotates,
// regardless of our own locally-tracked expiry. That only surfaces here, on
// the actual API call the token is used for, not at login time. Confirmed
// live 2026-10-13: "Failed to load products: Unauthenticated." on
// listSellerProducts with a cached token well inside its claimed 24h.
async function withAuthRetry<T>(
  ctx: ServiceContext<Clients>,
  auth: MdmAuth,
  fn: (auth: MdmAuth) => Promise<T>
): Promise<T> {
  try {
    return await fn(auth)
  } catch (err: any) {
    if (!looksLikeAuthFailure(err)) throw err
    await clearMdmToken(ctx)
    const fresh = await forceRefreshMdmConfig(ctx)
    if (!fresh?.mdmUsername || !fresh?.mdmPassword) throw err
    if (fresh.mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(fresh.mdmApiEndpoint)
    const freshToken = await getMdmToken(ctx, fresh.mdmUsername, fresh.mdmPassword, true)
    return await fn({ ...auth, token: freshToken, baseUrl: ctx.clients.mdm.getBaseUrl() })
  }
}

// GET /_v/mdm-seller/products-list — the new Products section's own list +
// filters, scoped to this seller by mdm_seller_id — NOT the same thing as
// getSellerProducts above (that one backs the Documents picker, vtex_linked
// only). Separate route/name on purpose to avoid confusing the two.
export async function listSellerProducts(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const auth = await mdmAuth(ctx)
  if (!auth) return

  const q = ctx.query as Record<string, string>
  const page = parseInt(q.page ?? '1', 10)
  const perPage = parseInt(q.per_page ?? '20', 10)

  try {
    const result = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getSellerProducts(a.token, a.mdmSellerId, page, perPage, {
      status: q.status,
      name: q.name,
      sku: q.sku,
      cas_number: q.cas_number,
      hs_code: q.hs_code,
      vtex_linked: q.vtex_linked,
      sort_by: q.sort_by,
      sort_direction: q.sort_direction,
    }))

    // Whether each product already exists in the SELLER's OWN catalog (via
    // Price & Inventory — sellerPid in MDM metadata) — entirely separate
    // from marketplace-link/Published status (that one's deliberately left
    // to a slower per-row live VTEX check, done progressively from the
    // frontend; this one is just a cheap MDM metadata read, so there's no
    // reason to pay for a second round trip per row — it's folded in here
    // instead, in parallel, same enrichment pattern as Export's columns).
    const products = Array.isArray(result?.products) ? result.products : []
    await Promise.all(products.map(async (p: any) => {
      if (!p?.id) return
      try {
        const metadata = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getProductMetadata(a.token, p.id))
        p.inSellerCatalog = !!metadata?.vtexPriceInventory?.sellerPid
      } catch {
        p.inSellerCatalog = false
      }
    }))

    ctx.body = { success: true, ...result }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load products', detail: mdmErrDetail(err) }
  }
}

// Export's extra columns, beyond the base MDM fields every row already has
// — the exact same VTEX-side fields the marketplace admin's Import/Link-to-
// SKU tabs show (see the marketplace app's getImportExistingDetails),
// fetched read-only here via marketplaceVtexClient's cross-account calls.
// Kept out of the bulk CSV *import* on purpose (2026-10-20, per explicit
// instruction) — these are read-only VTEX enrichment for a report, not
// fields MDM's import schema accepts.
const EXPORT_ENRICHMENT_COLUMNS = [
  'Category', 'Brand', 'Manufacturer Code', 'Modal Type',
  'Package Weight', 'Package Height', 'Package Length', 'Package Width',
  'Actual Weight', 'Actual Height', 'Actual Length', 'Actual Width',
  'Warehouse', 'Quantity', 'Price', 'List Price',
]
const EXPORT_COLUMNS = [
  'Name', 'SKU', 'CAS Number', 'HS Code', 'Origin', 'Status',
  'Tradechem PID', 'Tradechem SID',
  ...EXPORT_ENRICHMENT_COLUMNS,
]
function blankEnrichment(): string[] {
  return new Array(EXPORT_ENRICHMENT_COLUMNS.length).fill('')
}

// GET /_v/mdm-seller/products/export — same filters as the Products list
// (whatever's currently applied in the table), but every matching row
// across every page, enriched with live VTEX catalog/pricing/inventory
// data for linked products. Returns columns+rows rather than a CSV string
// directly — the frontend already has its own serializeCsv (used for the
// Skip-active-SKUs reupload path) and triggers the actual file download
// client-side via a Blob, so there's no need to deal with Content-
// Disposition/streaming here.
export async function exportSellerProducts(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const auth = await mdmAuth(ctx)
  if (!auth) return

  const q = ctx.query as Record<string, string>
  const filters = {
    status: q.status, name: q.name, sku: q.sku, cas_number: q.cas_number,
    hs_code: q.hs_code, vtex_linked: q.vtex_linked, sort_by: q.sort_by, sort_direction: q.sort_direction,
  }

  const EXPORT_PAGE_SIZE = 100
  const allProducts: any[] = []
  try {
    let page = 1
    let lastPage = 1
    do {
      const result = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getSellerProducts(a.token, a.mdmSellerId, page, EXPORT_PAGE_SIZE, filters))
      allProducts.push(...result.products)
      lastPage = result.lastPage || 1
      page++
    } while (page <= lastPage)
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load products for export', detail: mdmErrDetail(err) }
    return
  }

  const settings = await readMdmConfig(ctx)
  const { vtexAppKey, vtexAppToken } = settings
  const canEnrich = !!(vtexAppKey && vtexAppToken)

  let categoryMap = new Map<string, string>()
  let brandMap = new Map<string, string>()
  let warehouseMap = new Map<string, string>()
  if (canEnrich) {
    [categoryMap, brandMap, warehouseMap] = await Promise.all([
      getMarketplaceCategoryMap(vtexAppKey, vtexAppToken),
      getMarketplaceBrandMap(vtexAppKey, vtexAppToken),
      getMarketplaceWarehouseMap(vtexAppKey, vtexAppToken),
    ])
  }

  const rows: string[][] = []
  for (const p of allProducts) {
    const origin = Array.isArray(p.origin_countries) && p.origin_countries.length
      ? p.origin_countries.map((c: any) => c.name).join(', ')
      : ''
    const base = [
      p.name ?? '', p.sku ?? '', p.cas_number ?? '', p.hs_code ?? '', origin, p.status ?? '',
      p.vtex?.vtex_product_id != null ? String(p.vtex.vtex_product_id) : '',
      p.vtex?.vtex_sku_id != null ? String(p.vtex.vtex_sku_id) : '',
    ]

    const vtexProductId: string | undefined = p.vtex?.vtex_product_id != null ? String(p.vtex.vtex_product_id) : undefined
    if (!canEnrich || !p.vtex?.linked || !vtexProductId) {
      rows.push([...base, ...blankEnrichment()])
      continue
    }

    const product = await getMarketplaceProduct(vtexAppKey, vtexAppToken, vtexProductId)
    const categoryName = product?.CategoryId != null ? (categoryMap.get(String(product.CategoryId)) ?? String(product.CategoryId)) : ''
    const brandName = product?.BrandId != null ? (brandMap.get(String(product.BrandId)) ?? String(product.BrandId)) : ''

    let skuId: number | null = p.vtex?.vtex_sku_id ? Number(p.vtex.vtex_sku_id) : null
    if (!skuId) {
      const skus = await getMarketplaceSkusByProductId(vtexAppKey, vtexAppToken, vtexProductId)
      skuId = skus?.[0]?.Id ?? null
    }
    if (!skuId) {
      const enrichment = blankEnrichment()
      enrichment[0] = categoryName
      enrichment[1] = brandName
      rows.push([...base, ...enrichment])
      continue
    }

    const [sku, price, inventory] = await Promise.all([
      getMarketplaceSku(vtexAppKey, vtexAppToken, skuId),
      getMarketplacePrice(vtexAppKey, vtexAppToken, skuId),
      getMarketplaceInventory(vtexAppKey, vtexAppToken, skuId),
    ])
    const stockEntry = inventory.find((b: any) => (b?.totalQuantity ?? 0) > 0 || b?.hasUnlimitedQuantity) ?? inventory[0]

    rows.push([
      ...base,
      categoryName,
      brandName,
      sku?.ManufacturerCode ?? '',
      sku?.ModalType ?? '',
      sku?.PackagedWeightKg != null ? String(sku.PackagedWeightKg) : '',
      sku?.PackagedHeight != null ? String(sku.PackagedHeight) : '',
      sku?.PackagedLength != null ? String(sku.PackagedLength) : '',
      sku?.PackagedWidth != null ? String(sku.PackagedWidth) : '',
      sku?.WeightKg != null ? String(sku.WeightKg) : '',
      sku?.Height != null ? String(sku.Height) : '',
      sku?.Length != null ? String(sku.Length) : '',
      sku?.Width != null ? String(sku.Width) : '',
      stockEntry?.warehouseId ? (warehouseMap.get(String(stockEntry.warehouseId)) ?? String(stockEntry.warehouseId)) : '',
      stockEntry?.hasUnlimitedQuantity ? 'Unlimited' : (stockEntry?.totalQuantity != null ? String(stockEntry.totalQuantity) : ''),
      price?.basePrice ?? price?.costPrice ?? '',
      price?.listPrice ?? '',
    ])
  }

  ctx.body = { success: true, columns: EXPORT_COLUMNS, rows, total: rows.length }
}

// Beta API, no retrievable request/response schema (see SellerCatalogClient
// .createProduct's own note) — defensively tries every plausible shape for
// the created product/SKU ids rather than assuming one, so a wrong guess at
// least surfaces as a clear "couldn't find the ids in VTEX's response"
// instead of a silent crash.
// Confirmed live 2026-10-22 against VTEX's published response schema for
// this endpoint: { id: "<product id>", skus: [{ id: "<sku id>" }, ...] }.
// Kept defensively tolerant of a couple of capitalization variants in case
// that ever drifts, but id/skus[0].id is the real, confirmed shape now.
function extractSellerIds(res: any): { sellerPid?: string; sellerSid?: string } {
  const productId = res?.id ?? res?.Id
  const skuId = res?.skus?.[0]?.id ?? res?.Skus?.[0]?.Id
  return {
    sellerPid: productId != null ? String(productId) : undefined,
    sellerSid: skuId != null ? String(skuId) : undefined,
  }
}

// Durable link record (sellerPid/sellerSid + last-saved price/inventory),
// stored entirely in MDM's metadata endpoint now — keyed by mdm_product_id
// (always available, linked or not), per MDM's 2026-10-22 follow-up adding
// that route specifically for this. No VBase fallback needed anymore: MDM
// confirmed metadata pushed pre-link carries over automatically once a
// product later gets linked, and they've flagged mdm_product_id as the
// identifier they may standardize on long-term, so this is also the
// forward-compatible choice — see MdmClient.ts's own note.
//
// sellerPid/sellerSid are this SELLER's own independent catalog ids —
// unrelated to and never validated against vtex_product_id/vtex.linked
// (whether admin has imported/linked the MDM product into the
// marketplace's own catalog, used elsewhere in this handler for
// Export/live-status). The two linking relationships are intentionally
// kept separate; this endpoint never checks the other one.
interface PriceInventoryRecord {
  sellerPid: string
  sellerSid: string
  price: number
  listPrice: number | null
  warehouseId: string
  quantity: number | null
  unlimitedQuantity: boolean
  updatedAt: string
}

// GET /_v/mdm-seller/products/price-inventory?mdmProductId=
// Backs the Price & Inventory modal — which is really "create this product
// in the seller's own VTEX account, then manage its price/inventory
// natively" (2026-10-22, the client's explicit request; the marketplace's
// own admin-imported product is untouched by any of this, and this is
// available even before the product is linked/approved — it's the
// seller's own catalog either way).
//
// On every open: reads MDM's metadata (the authoritative record). If a
// sellerPid is found there, confirms with a live call that VTEX still has
// that product rather than trusting a possibly-stale record. Confirmed:
// creation fields (name/brand/category/dimensions) are locked and only
// Price/Inventory stay editable. Not confirmed (never created, or VTEX no
// longer has it): the full creation form is shown instead.
export async function getSellerPriceInventory(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const mdmProductId = (ctx.query as any).mdmProductId as string | undefined
  if (!mdmProductId) {
    ctx.body = { success: false, error: 'mdmProductId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  const userToken = (ctx.vtex as any)?.adminUserAuthToken

  let saved: PriceInventoryRecord | null = null
  try {
    const metadata = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getProductMetadata(a.token, mdmProductId))
    if (metadata?.vtexPriceInventory?.sellerPid) saved = metadata.vtexPriceInventory
  } catch {
    // Falls through to the not-linked/creation path below.
  }

  if (saved?.sellerPid) {
    try {
      const product = await ctx.clients.sellerCatalog.getProduct(Number(saved.sellerPid), userToken)
      if (product) {
        const warehouses = await ctx.clients.sellerCatalog.listWarehouses(userToken)
        ctx.body = {
          success: true,
          linked: true,
          sellerPid: saved.sellerPid,
          sellerSid: saved.sellerSid,
          price: saved.price ?? '',
          listPrice: saved.listPrice ?? '',
          warehouseId: saved.warehouseId ?? '',
          quantity: saved.quantity ?? '',
          unlimitedQuantity: !!saved.unlimitedQuantity,
          warehouses: warehouses.map((w: any) => ({ id: w.id, name: w.name })),
        }
        return
      }
    } catch {
      // VTEX no longer has this product (deleted, or the stored id is
      // stale/wrong) — fall through to the not-linked/creation path below.
    }
  }

  let brandsResult: { items: any[]; raw: any }
  let categoriesResult: { items: any[]; raw: any }
  let warehouses: any[] = []
  try {
    [brandsResult, categoriesResult, warehouses] = await Promise.all([
      ctx.clients.sellerCatalog.listBrands(userToken),
      ctx.clients.sellerCatalog.getCategoryTree(userToken),
      ctx.clients.sellerCatalog.listWarehouses(userToken),
    ])
  } catch (err: any) {
    ctx.body = { success: false, error: "Couldn't load your VTEX catalog options", detail: vtexErrDetail(err) }
    return
  }

  // Flattened for a plain dropdown — the tree's depth isn't shown anywhere
  // else in this app either (see marketplaceVtexClient.ts's own category
  // walk for the same pattern), indentation by depth is enough context.
  // Confirmed live 2026-10-22: each node is { value: {id, name, isActive},
  // children: [...] } — id/name sit under .value, not the node itself.
  //
  // Confirmed live 2026-10-23 (QA report: empty dropdown, raw response
  // showed real categories, every one isActive: false): VTEX built a
  // workaround for Seller Portal accounts with no category tree of their
  // own — they're handed the MARKETPLACE's own tree instead, so there's
  // still something meaningful to assign products to. In that workaround
  // every node comes back isActive: false, even though all of them are
  // valid to pick — false there means "not owned by this account", not
  // "disabled". The plain isActive!==false filter below was written for
  // the normal case (a seller with their own managed tree, where false
  // really does mean "retired, don't show it"). Detect which situation
  // this is: if literally nothing in the tree is ever active, nothing is
  // being disabled on purpose — show it all. A genuine mix still filters
  // out the false ones exactly as before.
  const anyActiveNode = (nodes: any[]): boolean => {
    for (const node of nodes ?? []) {
      const value = node?.value ?? node
      if (value?.isActive === true) return true
      if (Array.isArray(node?.children) && anyActiveNode(node.children)) return true
    }
    return false
  }
  const categoriesAllInactive = categoriesResult.items.length > 0 && !anyActiveNode(categoriesResult.items)

  const flatCategories: { id: string; name: string; depth: number }[] = []
  const walk = (nodes: any[], depth: number) => {
    for (const node of nodes ?? []) {
      const value = node?.value ?? node
      const id = value?.id ?? value?.Id
      const name = value?.name ?? value?.Name
      if (id != null && (categoriesAllInactive || value?.isActive !== false)) {
        flatCategories.push({ id: String(id), name: `${'— '.repeat(depth)}${name}`, depth })
      }
      if (Array.isArray(node?.children)) walk(node.children, depth + 1)
    }
  }
  walk(categoriesResult.items, 0)

  // Diagnostic, not a guess: if parsing found nothing but VTEX's raw
  // response wasn't an empty/trivial payload, surface the raw JSON instead
  // of silently showing an empty dropdown — this is a beta API with no
  // confirmed response schema, so "empty after parsing" could mean either
  // a genuinely empty account or a wrapper key we didn't anticipate.
  const rawNonTrivial = (raw: any) => {
    if (raw == null) return false
    try { return JSON.stringify(raw) !== '[]' && JSON.stringify(raw) !== '{}' } catch { return false }
  }
  const brandsDebug = brandsResult.items.length === 0 && rawNonTrivial(brandsResult.raw)
    ? (() => { try { return JSON.stringify(brandsResult.raw).slice(0, 2000) } catch { return String(brandsResult.raw) } })()
    : undefined
  const categoriesDebug = flatCategories.length === 0 && rawNonTrivial(categoriesResult.raw)
    ? (() => { try { return JSON.stringify(categoriesResult.raw).slice(0, 2000) } catch { return String(categoriesResult.raw) } })()
    : undefined

  // Same reasoning as categoriesAllInactive above — if this account's
  // brand list turns out to be the same kind of all-inactive marketplace
  // workaround, don't let the isActive filter silently empty it too.
  const brandsAllInactive = brandsResult.items.length > 0
    && !brandsResult.items.some((b: any) => (b.isActive ?? b.IsActive) === true)

  ctx.body = {
    success: true,
    linked: false,
    brands: brandsResult.items
      .filter((b: any) => brandsAllInactive || (b.isActive ?? b.IsActive) !== false)
      .map((b: any) => ({ id: String(b.id ?? b.Id), name: b.name ?? b.Name })),
    brandsDebug,
    categories: flatCategories,
    categoriesDebug,
    warehouses: warehouses.map((w: any) => ({ id: w.id, name: w.name })),
  }
}

// POST /_v/mdm-seller/products/price-inventory
// Quick-edit path for a product that ALREADY exists in the seller's own
// catalog (sellerPid/sellerSid already on hand) — just price/inventory.
// First-time creation no longer goes through this single call at all; it's
// a multi-step wizard now (see runPriceInventoryStep below), since a VTEX-
// side failure partway through (e.g. attaching media) must be independently
// retryable rather than silently swallowed. This endpoint stays a plain
// one-shot call because by this point the product/SKU are already proven
// to exist — there's nothing here that benefits from step-by-step retry.
export async function saveSellerPriceInventory(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const { mdmProductId, price, listPrice, warehouseId, quantity, unlimitedQuantity, sellerPid, sellerSid } = parsed

  if (!mdmProductId || !sellerPid || !sellerSid) {
    ctx.body = { success: false, error: 'mdmProductId, sellerPid and sellerSid are required — a new product is created via the step wizard, not this endpoint' }
    return
  }
  if (!(Number(price) > 0) || !warehouseId || (!unlimitedQuantity && !(Number(quantity) > 0))) {
    ctx.body = { success: false, error: 'A price greater than zero, warehouseId and quantity (or unlimited) are required' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  const userToken = (ctx.vtex as any)?.adminUserAuthToken
  const skuId = Number(sellerSid)
  try {
    await ctx.clients.sellerPricing.setPrice(skuId, Number(price), Number(listPrice) || undefined, userToken)
    await ctx.clients.sellerCatalog.setInventory(skuId, String(warehouseId), Number(quantity) || 0, !!unlimitedQuantity, userToken)
  } catch (err: any) {
    ctx.body = { success: false, error: 'VTEX rejected the price/inventory update', detail: vtexErrDetail(err) }
    return
  }

  const record: PriceInventoryRecord = {
    sellerPid: String(sellerPid),
    sellerSid: String(sellerSid),
    price: Number(price),
    listPrice: Number(listPrice) || null,
    warehouseId: String(warehouseId),
    quantity: unlimitedQuantity ? null : Number(quantity),
    unlimitedQuantity: !!unlimitedQuantity,
    updatedAt: new Date().toISOString(),
  }

  let metadataError: string | undefined
  try {
    const current = (await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getProductMetadata(a.token, mdmProductId))) ?? {}
    await withAuthRetry(ctx, auth, a => ctx.clients.mdm.setProductMetadata(a.token, mdmProductId, { ...current, vtexPriceInventory: record }))
  } catch (err: any) {
    metadataError = mdmErrDetail(err)
  }

  ctx.body = { success: true, sellerPid: String(sellerPid), sellerSid: String(sellerSid), metadataError }
}

function safeJson(v: any): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

// GET /_v/mdm-seller/products/media-proxy?url=<encoded MDM image URL>
// Downloads an MDM-hosted image server-side and re-serves its bytes from
// this app's own origin. Used by the Price & Inventory wizard's "Uploading
// media" step (see PriceInventoryModal.js) so the browser can fetch the
// bytes without a cross-origin request to MDM's media host — that step's
// own upload-to-VTEX call runs in the browser now, not here (see that
// file's own note on why: uploading from this backend to VTEX's private
// Catalog Images endpoint consistently failed live 2026-10-23 with "Client
// network socket disconnected before secure TLS connection was
// established" — a connection dropped before any HTTP response, every
// single attempt, not a transient blip retries could paper over. That
// route is only reachable the way VTEX's own admin UI reaches it: a real,
// same-origin browser request. Downloading FROM MDM server-side was never
// the problem, so this proxy step stays server-side.)
export async function proxySellerMediaDownload(ctx: ServiceContext<Clients>) {
  const url = (ctx.query as any).url as string | undefined
  if (!url) {
    ctx.status = 400
    ctx.body = 'url is required'
    return
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    ctx.status = 400
    ctx.body = 'Invalid url'
    return
  }
  const host = parsed.hostname.toLowerCase()
  const isPrivate = host === 'localhost' || host.startsWith('127.') || host.startsWith('10.')
    || host.startsWith('192.168.') || host.startsWith('169.254.') || host === '0.0.0.0'
  if (parsed.protocol !== 'https:' || isPrivate) {
    ctx.status = 400
    ctx.body = 'url must be a public https URL'
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const res = await fetch(url)
    if (!res.ok) {
      ctx.status = res.status
      ctx.body = `Upstream returned HTTP ${res.status}`
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    ctx.status = 200
    ctx.set('Content-Type', res.headers.get('content-type') || 'application/octet-stream')
    ctx.set('Cache-Control', 'private, max-age=300')
    ctx.body = buf
  } catch (err: any) {
    ctx.status = 502
    ctx.body = `Failed to download image: ${err?.message ?? 'unknown error'}`
  }
}

// POST /_v/mdm-seller/products/price-inventory/step
// Body: { step, mdmProductId, ...fields the given step needs }
// steps, in order: media → product → price → inventory → finalize. Each
// one is its own independent call so the frontend (PriceInventoryModal.js)
// can run them as a retryable chain, matching the marketplace admin app's
// own Import/Link step-wizard pattern (2026-10-23, explicit instruction) —
// nothing here is best-effort; a failure at any step halts the chain and
// the frontend shows a Retry for that step alone, re-sending
// sellerPid/sellerSid (and the uploaded image list) once the earlier steps
// actually succeeded so a retry never tries to recreate it.
//
// NOTE: the 'media' step itself is NOT handled here (2026-10-23) — it runs
// entirely in the browser now (see PriceInventoryModal.js). The frontend
// calls this endpoint directly for 'product'/'price'/'inventory'/
// 'finalize' only, after it already has the uploaded image list in hand.
export async function runPriceInventoryStep(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let body: any = {}
  try { body = JSON.parse(raw) } catch {}

  const { step, mdmProductId } = body
  if (!step || !mdmProductId) {
    ctx.body = { success: false, error: 'step and mdmProductId are required' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return
  const userToken = (ctx.vtex as any)?.adminUserAuthToken

  try {
    if (step === 'product') {
      const { sellerPid, sellerSid, name, refId, brandId, categoryId, taxCode, ean, packageWeight, packageWidth, packageHeight, packageLength, images } = body
      // Idempotent: once this has actually succeeded once, a retry of a
      // LATER step re-sends these same ids rather than recreating anything.
      if (sellerPid && sellerSid) {
        ctx.body = { success: true, sellerPid: String(sellerPid), sellerSid: String(sellerSid) }
        return
      }
      if (!name || !brandId || !categoryId || !(Number(packageWeight) > 0) || !(Number(packageWidth) > 0) || !(Number(packageHeight) > 0) || !(Number(packageLength) > 0)) {
        ctx.body = { success: false, error: 'name, brand, category and all package dimensions are required to create this product' }
        return
      }
      const imageList: { id: string; url: string; alt?: string }[] = Array.isArray(images) ? images : []
      if (imageList.length === 0) {
        ctx.body = { success: false, error: 'Media must be uploaded before the product can be created — retry the media step first.' }
        return
      }
      try {
        // See createProduct's own note for the confirmed schema this
        // payload is built against. images/skus[].images reference the
        // already-uploaded ids from the media step above, exactly as the
        // native Seller Portal create screen itself does.
        const slug = `/${String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')}`
        const created = await ctx.clients.sellerCatalog.createProduct({
          status: 'active',
          name,
          brandId: String(brandId),
          categoryIds: [String(categoryId)],
          specs: [],
          attributes: [],
          slug,
          images: imageList.map(im => ({ id: im.id, url: im.url, alt: im.alt || name })),
          externalId: refId || undefined,
          taxCode: taxCode || undefined,
          origin: ctx.vtex.account,
          skus: [{
            name,
            isActive: true,
            externalId: refId || undefined,
            ean: ean || undefined,
            weight: Math.round(Number(packageWeight) * 1000),
            dimensions: {
              width: Number(packageWidth),
              height: Number(packageHeight),
              length: Number(packageLength),
            },
            specs: null,
            images: imageList.map(im => im.id),
          }],
        }, userToken)
        const ids = extractSellerIds(created)
        if (!ids.sellerPid || !ids.sellerSid) {
          ctx.body = { success: false, error: "VTEX created the product but didn't return a recognizable product/SKU id", detail: safeJson(created) }
          return
        }
        ctx.body = { success: true, sellerPid: ids.sellerPid, sellerSid: ids.sellerSid }
      } catch (err: any) {
        ctx.body = { success: false, error: 'VTEX rejected creating this product in your catalog', detail: vtexErrDetail(err) }
      }
      return
    }

    if (step === 'price') {
      const { sellerSid, price, listPrice } = body
      if (!sellerSid || !(Number(price) > 0)) { ctx.body = { success: false, error: 'sellerSid and a price greater than zero are required' }; return }
      try {
        await ctx.clients.sellerPricing.setPrice(Number(sellerSid), Number(price), Number(listPrice) || undefined, userToken)
        ctx.body = { success: true }
      } catch (err: any) {
        ctx.body = { success: false, error: 'VTEX rejected setting the price', detail: vtexErrDetail(err) }
      }
      return
    }

    if (step === 'inventory') {
      const { sellerSid, warehouseId, quantity, unlimitedQuantity } = body
      if (!sellerSid || !warehouseId || (!unlimitedQuantity && !(Number(quantity) > 0))) {
        ctx.body = { success: false, error: 'sellerSid, warehouseId and quantity (or unlimited) are required' }
        return
      }
      try {
        await ctx.clients.sellerCatalog.setInventory(Number(sellerSid), String(warehouseId), Number(quantity) || 0, !!unlimitedQuantity, userToken)
        ctx.body = { success: true }
      } catch (err: any) {
        ctx.body = { success: false, error: 'VTEX rejected setting inventory', detail: vtexErrDetail(err) }
      }
      return
    }

    if (step === 'finalize') {
      const { sellerPid, sellerSid, price, listPrice, warehouseId, quantity, unlimitedQuantity } = body
      if (!sellerPid || !sellerSid) { ctx.body = { success: false, error: 'sellerPid and sellerSid are required' }; return }
      const record: PriceInventoryRecord = {
        sellerPid: String(sellerPid),
        sellerSid: String(sellerSid),
        price: Number(price),
        listPrice: Number(listPrice) || null,
        warehouseId: String(warehouseId),
        quantity: unlimitedQuantity ? null : Number(quantity),
        unlimitedQuantity: !!unlimitedQuantity,
        updatedAt: new Date().toISOString(),
      }
      try {
        const current = (await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getProductMetadata(a.token, mdmProductId))) ?? {}
        await withAuthRetry(ctx, auth, a => ctx.clients.mdm.setProductMetadata(a.token, mdmProductId, { ...current, vtexPriceInventory: record }))
        ctx.body = { success: true }
      } catch (err: any) {
        ctx.body = { success: false, error: 'Failed to save this to MDM', detail: mdmErrDetail(err) }
      }
      return
    }

    ctx.body = { success: false, error: `Unknown step: ${step}` }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Unexpected error', detail: err?.message ?? String(err) }
  }
}

// POST /_v/mdm-seller/products/unpublish?mdmProductId=... — flips an Active
// product back to Pending Approval. MDM scopes this to the calling seller
// server-side (403 if not the actual owner), so auth.vtexSellerId is enough;
// no extra ownership check needed on our end.
export async function unpublishSellerProduct(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const mdmProductId = (ctx.query as any).mdmProductId as string | undefined
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined
  if (!mdmProductId) {
    ctx.body = { success: false, error: 'mdmProductId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  let result: any
  try {
    result = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.unpublishProduct(a.token, mdmProductId, a.vtexSellerId))
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to unpublish product', detail: mdmErrDetail(err) }
    return
  }

  // MDM side succeeded. Confirmed live 2026-10-12 that this app's own
  // sandbox can call tradeasiab2b's native VTEX Catalog API directly with
  // the keys fetched via the shared-config relay — no need to wait on
  // MDM's webhook for this particular path (that's only the backstop for
  // cases neither app is ever told about, e.g. MDM's own admin CSV
  // reimport). Deactivate the linked VTEX product in the same request.
  if (!vtexProductId) {
    ctx.body = { success: true, result }
    return
  }

  const settings = await readMdmConfig(ctx)
  const { vtexAppKey, vtexAppToken } = settings
  if (!vtexAppKey || !vtexAppToken) {
    ctx.body = { success: true, result, vtexDeactivateError: 'VTEX API keys not configured' }
    return
  }

  const deactivation = await deactivateMarketplaceVtexProduct(vtexAppKey, vtexAppToken, vtexProductId)
  if (!deactivation.success) {
    ctx.body = { success: true, result, vtexDeactivateError: deactivation.detail ?? deactivation.error }
    return
  }

  ctx.body = { success: true, result, vtexDeactivated: true }
}

// GET /_v/mdm-seller/products/vtex-status?vtexProductId=... — read-only
// live check of the linked VTEX product's actual Active/Inactive state,
// since MDM's own status field can't be trusted alone to reflect it (see
// ProductStatusModal.js). No seller-ownership check needed: read-only,
// and the vtexProductId only ever reaches the client already scoped to one
// of this seller's own linked products.
export async function getVtexProductStatusHandler(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined
  if (!vtexProductId) {
    ctx.body = { success: false, error: 'vtexProductId is required' }
    return
  }

  const settings = await readMdmConfig(ctx)
  const { vtexAppKey, vtexAppToken } = settings
  if (!vtexAppKey || !vtexAppToken) {
    ctx.body = { success: false, error: 'VTEX API keys not configured' }
    return
  }

  const result = await getMarketplaceVtexProductStatus(vtexAppKey, vtexAppToken, vtexProductId)
  if (!result.success) {
    ctx.body = { success: false, error: 'Failed to check VTEX status', detail: result.error }
    return
  }
  ctx.body = { success: true, isActive: result.isActive, name: result.name }
}

// POST /_v/mdm-seller/products/edit-link?mdmProductId=... — issues a fresh,
// one-time MDM-hosted edit link for one product, scoped to this seller.
// Never cached: a new link invalidates whatever was issued before it for
// this product+seller pair, so this is only called right when the seller
// clicks Edit, same as unpublish is only called right when they click it.
export async function getSellerEditLink(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const mdmProductId = (ctx.query as any).mdmProductId as string | undefined
  if (!mdmProductId) {
    ctx.body = { success: false, error: 'mdmProductId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const link = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getEditLink(a.token, mdmProductId, a.vtexSellerId))
    ctx.body = { success: true, url: link.url, expiresAt: link.expiresAt }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to get edit link', detail: mdmErrDetail(err) }
  }
}

// POST /_v/mdm-seller/products/add-link — issues a fresh MDM-hosted link
// for creating one new product, attributed to this seller once they save it.
export async function getSellerAddLink(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const link = await withAuthRetry(ctx, auth, a => ctx.clients.mdm.getAddLink(a.token, a.vtexSellerId))
    ctx.body = { success: true, url: link.url, expiresAt: link.expiresAt }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to get add-product link', detail: mdmErrDetail(err) }
  }
}

// Routes to MDM's mdm_product_id-keyed endpoints when there's no VTEX link
// yet (see MdmClient's *ByMdmId methods) — lets sellers add media right
// after import instead of waiting on admin approval + linking first. Once a
// product IS linked, the vtex_product_id route is used instead; MDM
// confirmed media added pre-link carries over automatically either way.
export async function getSellerProductMedia(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined
  const mdmProductId = (ctx.query as any).mdmProductId as string | undefined
  if (!vtexProductId && !mdmProductId) {
    ctx.body = { success: false, error: 'vtexProductId or mdmProductId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const media = await withAuthRetry(ctx, auth, a => vtexProductId
      ? ctx.clients.mdm.getProductMedia(a.token, vtexProductId, a.vtexSellerId)
      : ctx.clients.mdm.getProductMediaByMdmId(a.token, mdmProductId as string, a.vtexSellerId))
    // currentSellerId lets the frontend gate the Remove button per-item on
    // media[].vtex_seller_id — belt-and-braces per MDM (2026-08-13): passing
    // vtex_seller_id here already filters the list to this seller's own
    // uploads server-side, so every item should already be theirs, but the
    // client-side check stays correct even if that filtering ever changes.
    ctx.body = { success: true, media, currentSellerId: auth.vtexSellerId }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load media', detail: mdmErrDetail(err) }
  }
}

function readRawBody(ctx: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    ctx.req.on('data', (c: Buffer) => chunks.push(c))
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)))
    ctx.req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

// Self-hosting for uploaded images — MDM's media endpoint is URL-based, not
// raw-upload, so something has to turn a seller's local file into a
// fetchable URL first. VTEX's own File Manager (/api/portal/pvt/sites/...)
// was tried first and confirmed broken for this account: it 404s with
// "Loja não encontrada" ("Store not found"), since that API is a
// storefront/CMS concept — Seller Portal accounts like this one have no
// "site" configured at all. VBase + a route on this app serving the bytes
// back out sidesteps that entirely; it's the one mechanism already proven
// reliable everywhere else in this app all session.
const MEDIA_BUCKET = 'mdmmed'
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 // base64 inflates ~33% — keeps the stored VBase value comfortably under ~5.5MB

function mediaUrl(ctx: ServiceContext<Clients>, key: string): string {
  return `https://${ctx.vtex.workspace}--${ctx.vtex.account}.myvtex.com/_v/mdm-seller/media?key=${encodeURIComponent(key)}`
}

// GET /_v/mdm-seller/media?key= — serves back an image stored by
// addSellerProductMedia below. Public/unauthenticated on purpose: MDM's
// servers fetch this URL directly to download the image, with no VTEX
// session of their own to present.
export async function serveSellerProductMedia(ctx: ServiceContext<Clients>) {
  const key = (ctx.query as any).key as string | undefined
  if (!key) {
    ctx.status = 400
    ctx.body = 'key is required'
    return
  }
  try {
    const stored = await ctx.clients.vbase.getJSON<{ contentType: string; base64: string }>(MEDIA_BUCKET, key, true)
    if (!stored) {
      ctx.status = 404
      ctx.body = 'Not found'
      return
    }
    ctx.status = 200
    ctx.set('Content-Type', stored.contentType || 'application/octet-stream')
    ctx.set('Cache-Control', 'public, max-age=31536000, immutable')
    ctx.body = Buffer.from(stored.base64, 'base64')
  } catch {
    ctx.status = 500
    ctx.body = 'Failed to load media'
  }
}

// POST /_v/mdm-seller/products/media?vtexProductId= — multipart with a
// single `file` field (the image). Stores it via VBase (see above), then
// hands MDM the resulting self-hosted URL.
export async function addSellerProductMedia(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined
  const mdmProductId = (ctx.query as any).mdmProductId as string | undefined
  if (!vtexProductId && !mdmProductId) {
    ctx.body = { success: false, error: 'vtexProductId or mdmProductId is required' }
    return
  }

  const contentType = ctx.req.headers['content-type'] ?? ''
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
    ctx.body = { success: false, error: 'Expected multipart/form-data' }
    return
  }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2]

  const body = await readRawBody(ctx)
  if (!body.length) {
    ctx.body = { success: false, error: 'Empty upload body' }
    return
  }

  // Minimal multipart parse — this form only ever carries one file field, so
  // a full multipart library is overkill. Finds the first part with a
  // filename, extracts its Content-Type and raw bytes between the header
  // block and the next boundary.
  const boundaryBuf = Buffer.from(`--${boundary}`)
  const parts: Buffer[] = []
  let searchStart = 0
  while (true) {
    const start = body.indexOf(boundaryBuf, searchStart)
    if (start === -1) break
    const next = body.indexOf(boundaryBuf, start + boundaryBuf.length)
    if (next === -1) break
    parts.push(body.slice(start + boundaryBuf.length, next))
    searchStart = next
  }

  let fileBuffer: Buffer | null = null
  let fileName = 'upload.jpg'
  let fileContentType = 'application/octet-stream'
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headerText = part.slice(0, headerEnd).toString('utf8')
    if (!/name="file"/.test(headerText)) continue
    const nameMatch = headerText.match(/filename="([^"]*)"/)
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i)
    if (nameMatch?.[1]) fileName = nameMatch[1]
    if (typeMatch?.[1]) fileContentType = typeMatch[1].trim()
    let content = part.slice(headerEnd + 4)
    if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2)
    fileBuffer = content
    break
  }

  if (!fileBuffer || !fileBuffer.length) {
    ctx.body = { success: false, error: 'No file field found in upload' }
    return
  }
  if (fileBuffer.length > MAX_MEDIA_BYTES) {
    ctx.body = { success: false, error: `Image too large — max ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB` }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await ctx.clients.vbase.saveJSON(MEDIA_BUCKET, key, {
      contentType: fileContentType,
      base64: fileBuffer.toString('base64'),
    })
    const result = await withAuthRetry(ctx, auth, a => vtexProductId
      ? ctx.clients.mdm.addProductMedia(a.token, vtexProductId, a.vtexSellerId, [
          { url: mediaUrl(ctx, key), alt: fileName },
        ])
      : ctx.clients.mdm.addProductMediaByMdmId(a.token, mdmProductId as string, a.vtexSellerId, [
          { url: mediaUrl(ctx, key), alt: fileName },
        ]))
    ctx.body = { success: true, result }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to add media', detail: mdmErrDetail(err) }
  }
}

export async function deleteSellerProductMedia(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const mediaId = Number((ctx.query as any).mediaId)
  if (!mediaId) {
    ctx.body = { success: false, error: 'mediaId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    await withAuthRetry(ctx, auth, a => ctx.clients.mdm.deleteProductMedia(a.token, mediaId))
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to delete media', detail: mdmErrDetail(err) }
  }
}

// Splices a form field into a raw multipart body just before the closing
// boundary — same technique as sellerDocumentsHandler.ts's
// appendMultipartField, used to inject vtex_seller_id server-side.
function appendMultipartField(body: Buffer, boundary: string, name: string, value: string): Buffer {
  const closing = Buffer.from(`--${boundary}--`)
  const idx = body.lastIndexOf(closing)
  if (idx === -1) return body
  const field = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  )
  return Buffer.concat([body.slice(0, idx), field, body.slice(idx)])
}

// POST /_v/mdm-seller/products/import — multipart CSV, forwarded to MDM
// as-is (same proxy pattern as uploadSellerDocument), with vtex_seller_id
// injected server-side so the browser can never spoof another seller's
// identity. MDM forces status=pending_approval/seller/source/attribute_set
// on every row created this way — nothing to add on our side for that.
export async function importSellerProducts(ctx: ServiceContext<Clients>) {
  ctx.status = 200

  const contentType = ctx.req.headers['content-type'] ?? ''
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
    ctx.body = { success: false, error: 'Expected multipart/form-data' }
    return
  }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2]

  let body = await readRawBody(ctx)
  if (!body.length) {
    ctx.body = { success: false, error: 'Empty upload body' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  body = appendMultipartField(body, boundary, 'vtex_seller_id', auth.vtexSellerId)

  try {
    const res = await withAuthRetry(ctx, auth, a => axios.post(
      `${a.baseUrl}/vtex/products/import`,
      body,
      {
        headers: {
          Authorization: `Bearer ${a.token}`,
          Accept: 'application/json',
          'Content-Type': contentType,
        },
        maxBodyLength: Infinity,
        timeout: 30000,
      }
    ))
    ctx.body = { success: true, result: res.data?.data ?? null }
  } catch (err: any) {
    if (err?.response?.status === 422) {
      ctx.body = { success: false, error: 'Import rejected', detail: mdmErrDetail(err) }
      return
    }
    ctx.body = { success: false, error: 'Import failed', detail: mdmErrDetail(err) }
  }
}
