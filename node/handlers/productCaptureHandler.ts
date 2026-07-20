import { EventContext, ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { getSellerMdmToken } from './devSettingsHandler'

// Seller products captured from the seller's own catalog and flushed to MDM.
// MDM's composite link key (vtex_seller_id, vtex_product_id) is live: seller
// ids can never collide with marketplace ids, seller creates land as
// status "pending" (server-forced) for admin approval in MDM.
// Short name — VBase prefixes the app id and caps bucket names at 50 chars
const QUEUE_BUCKET = 'mdmq'
const QUEUE_INDEX = 'index'
const EVENT_LOG_KEY = 'event-log'
const EVENT_LOG_MAX = 30

interface CaptureResult {
  captured: boolean
  productId?: number
  reason?: string
  item?: any
  error?: string
}

// Best-effort field extraction — the Seller Portal product shape differs from
// the classic catalog; probe common shapes and keep the raw product for
// diagnosis until the shape is confirmed against a real seller product.
function extractFields(product: any) {
  const attrs: any[] = product?.attributes ?? product?.specifications ?? []
  const attr = (names: string[]) => {
    for (const a of attrs) {
      const n = String(a?.name ?? a?.Name ?? '').toLowerCase().trim()
      if (names.includes(n)) return a?.value ?? a?.Value ?? a?.values?.[0] ?? null
    }
    return null
  }
  return {
    name: product?.name ?? product?.Name ?? '',
    description: product?.description ?? product?.Description ?? '',
    cas_number: attr(['cas number', 'cas']) ?? '',
    hs_code: attr(['hs code', 'hs']) ?? '',
    origin: attr(['country of origin', 'origin countries', 'origin']),
  }
}

async function captureProduct(ctx: { clients: Clients; vtex: { account: string } }, productId: number, userToken?: string): Promise<CaptureResult> {
  let product: any
  try {
    product = await ctx.clients.sellerCatalog.getProduct(productId, userToken)
  } catch (err: any) {
    const detail = err?.response?.data
      ? `${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
      : err?.message
    return { captured: false, productId, reason: 'catalog_fetch_failed', error: detail }
  }
  if (!product) return { captured: false, productId, reason: 'product_not_found' }

  const fields = extractFields(product)
  if (!fields.name) return { captured: false, productId, reason: 'product_has_no_name' }

  const key = `p${productId}`
  let existing: any = null
  try { existing = await ctx.clients.vbase.getJSON<any>(QUEUE_BUCKET, key, true) } catch {}

  const item: any = {
    vtex_product_id: String(productId),
    vtex_seller_id: ctx.vtex.account,
    ...fields,
    state: 'captured',
    capturedAt: existing?.capturedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mdm: existing?.mdm ?? null,
    // compact shape sample for diagnosing the Seller Portal product structure
    rawKeys: Object.keys(product ?? {}),
    rawAttributes: (product?.attributes ?? product?.specifications ?? []).slice(0, 20),
  }

  // Flush to MDM — the seller token binds the scope server-side; the explicit
  // vtex_seller_id also covers the admin-credential dev fallback
  const token = await getSellerMdmToken(ctx)
  if (!token) {
    item.state = 'flush_failed'
    item.flushError = 'MDM credentials/token not configured'
  } else {
    try {
      const payload: any = {
        name: fields.name,
        cas_number: fields.cas_number,
        hs_code: fields.hs_code,
        vtex_product_id: String(productId),
        vtex_seller_id: ctx.vtex.account,
      }
      if (fields.description) payload.description = fields.description
      const data = await ctx.clients.mdm.upsertProduct(token, payload)
      item.state = data?.status === 'pending' ? 'pending_approval' : `synced_${data?.status ?? 'ok'}`
      item.mdm = { id: data?.id, sku: data?.sku, status: data?.status, created: data?.created }
      item.flushError = null
    } catch (err: any) {
      const d = err?.response?.data
      item.state = 'flush_failed'
      item.flushError = d?.message ?? JSON.stringify(d?.errors ?? err?.message ?? 'unknown').slice(0, 300)
    }
  }

  let saveWarning: string | undefined
  try {
    await ctx.clients.vbase.saveJSON(QUEUE_BUCKET, key, item)
    const index: number[] = (await ctx.clients.vbase.getJSON<number[]>(QUEUE_BUCKET, QUEUE_INDEX, true)) ?? []
    if (!index.includes(productId)) {
      index.unshift(productId)
      await ctx.clients.vbase.saveJSON(QUEUE_BUCKET, QUEUE_INDEX, index)
    }
  } catch (err: any) {
    const d = err?.response?.data
    saveWarning = d ? `${err.response.status}: ${JSON.stringify(d).slice(0, 200)}` : err?.message
  }

  return { captured: true, productId, item, error: saveWarning }
}

async function recordEvent(ctx: { clients: Clients }, entry: any) {
  try {
    const log: any[] = (await ctx.clients.vbase.getJSON<any[]>(QUEUE_BUCKET, EVENT_LOG_KEY, true)) ?? []
    log.unshift({ at: new Date().toISOString(), ...entry })
    await ctx.clients.vbase.saveJSON(QUEUE_BUCKET, EVENT_LOG_KEY, log.slice(0, EVENT_LOG_MAX))
  } catch {}
}

// Broadcaster event — seller-account payloads include ProductId
export async function catalogCapture(ctx: EventContext<Clients>) {
  const body: any = ctx.body ?? {}
  const productId = Number(body.ProductId ?? 0) || null
  if (!productId) {
    await recordEvent(ctx, { type: 'event_no_product_id', bodyKeys: Object.keys(body) })
    return
  }
  const result = await captureProduct(ctx as any, productId)
  await recordEvent(ctx, {
    type: 'event',
    productId,
    skuId: body.IdSku ?? null,
    captured: result.captured,
    reason: result.reason ?? 'ok',
    error: result.error,
  })
}

// Manual capture: GET /_v/mdm-seller/capture?productId=1
export async function manualCapture(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const productId = Number((ctx.query as any).productId)
  if (!productId) {
    ctx.body = { success: false, error: 'productId query param is required' }
    return
  }
  const userToken = (ctx.vtex as any)?.adminUserAuthToken
  const result = await captureProduct(ctx as any, productId, userToken)
  ctx.body = { success: result.captured, ...result, usedUserToken: !!userToken }
}

// My Products: GET /_v/mdm-seller/my-products — the seller's captured queue
export async function listMyProducts(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  let index: number[] = []
  try { index = (await ctx.clients.vbase.getJSON<number[]>(QUEUE_BUCKET, QUEUE_INDEX, true)) ?? [] } catch {}
  const products: any[] = []
  for (const id of index.slice(0, 100)) {
    try {
      const item = await ctx.clients.vbase.getJSON<any>(QUEUE_BUCKET, `p${id}`, true)
      if (item) {
        const { raw, ...summary } = item
        products.push(summary)
      }
    } catch {}
  }
  ctx.body = { success: true, count: products.length, products }
}

// Diagnostics: GET /_v/mdm-seller/capture-events
export async function captureEventLog(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  let log: any[] = []
  try { log = (await ctx.clients.vbase.getJSON<any[]>(QUEUE_BUCKET, EVENT_LOG_KEY, true)) ?? [] } catch {}
  ctx.body = { count: log.length, events: log }
}
