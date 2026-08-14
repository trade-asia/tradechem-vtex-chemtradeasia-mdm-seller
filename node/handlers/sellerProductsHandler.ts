import { ServiceContext } from '@vtex/api'
import axios from 'axios'
import { Clients } from '../clients'
import { getMdmToken, clearMdmToken } from '../helpers/getMdmToken'
import { ensureSellerSynced } from '../helpers/sellerSync'
import { readMdmConfig } from './devSettingsHandler'

async function readSettings(ctx: ServiceContext<Clients>): Promise<any | null> {
  const settings = await readMdmConfig(ctx)

  const { mdmUsername, mdmPassword } = settings
  if (!mdmUsername || !mdmPassword) {
    ctx.status = 200
    ctx.body = { success: false, error: 'MDM credentials not configured in app settings.' }
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
  const { mdmApiEndpoint, mdmUsername, mdmPassword } = settings
  if (!mdmUsername || !mdmPassword) {
    ctx.body = { success: false, error: 'MDM credentials not configured in app settings.' }
    return null
  }
  if (mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(mdmApiEndpoint)

  const token = await getMdmToken(ctx, mdmUsername, mdmPassword)
  const userToken: string | undefined = (ctx.vtex as any)?.adminUserAuthToken
  const mdmSellerId = await ensureSellerSynced(ctx as any, token, userToken)
  if (!mdmSellerId) {
    ctx.body = { success: false, error: 'Could not sync this seller with MDM yet — try reloading the page.' }
    return null
  }

  return { token, baseUrl: ctx.clients.mdm.getBaseUrl(), vtexSellerId: ctx.vtex.account, mdmSellerId }
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
    const result = await ctx.clients.mdm.getSellerProducts(auth.token, auth.mdmSellerId, page, perPage, {
      status: q.status,
      name: q.name,
      sku: q.sku,
      cas_number: q.cas_number,
      hs_code: q.hs_code,
      vtex_linked: q.vtex_linked,
    })
    ctx.body = { success: true, ...result }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load products', detail: mdmErrDetail(err) }
  }
}

export async function getSellerProductMedia(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined
  if (!vtexProductId) {
    ctx.body = { success: false, error: 'vtexProductId is required' }
    return
  }
  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const media = await ctx.clients.mdm.getProductMedia(auth.token, vtexProductId, auth.vtexSellerId)
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
  if (!vtexProductId) {
    ctx.body = { success: false, error: 'vtexProductId is required' }
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
    const result = await ctx.clients.mdm.addProductMedia(auth.token, vtexProductId, auth.vtexSellerId, [
      { url: mediaUrl(ctx, key), alt: fileName },
    ])
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
    await ctx.clients.mdm.deleteProductMedia(auth.token, mediaId)
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
    const res = await axios.post(
      `${auth.baseUrl}/vtex/products/import`,
      body,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json',
          'Content-Type': contentType,
        },
        maxBodyLength: Infinity,
        timeout: 30000,
      }
    )
    ctx.body = { success: true, result: res.data?.data ?? null }
  } catch (err: any) {
    if (err?.response?.status === 422) {
      ctx.body = { success: false, error: 'Import rejected', detail: mdmErrDetail(err) }
      return
    }
    ctx.body = { success: false, error: 'Import failed', detail: mdmErrDetail(err) }
  }
}
