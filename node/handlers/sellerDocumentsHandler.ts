import { ServiceContext } from '@vtex/api'
import axios from 'axios'
import { Clients } from '../clients'
import { readBody } from '../helpers/readBody'
import { getMdmToken } from '../helpers/getMdmToken'
import { readMdmConfig } from './devSettingsHandler'

// MDM response envelope: { success, statusCode, message, data, errors }
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
  sellerId: string
}

// The seller identity is ALWAYS the account this app is installed on — never
// anything sent by the browser. This is the core security property of the app.
async function mdmAuth(ctx: ServiceContext<Clients>): Promise<MdmAuth | null> {
  const settings = await readMdmConfig(ctx)

  const { mdmApiEndpoint, mdmUsername, mdmPassword } = settings
  if (!mdmUsername || !mdmPassword) {
    ctx.body = { success: false, error: 'MDM credentials not configured in app settings.' }
    return null
  }

  if (mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(mdmApiEndpoint)
  const token = await getMdmToken(ctx, mdmUsername, mdmPassword)
  return { token, baseUrl: ctx.clients.mdm.getBaseUrl(), sellerId: ctx.vtex.account }
}

export async function getSellerDocuments(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const vtexProductId = (ctx.query as any).vtexProductId as string | undefined

  if (!vtexProductId) {
    ctx.body = { success: false, error: 'vtexProductId is required' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    const documents = await ctx.clients.mdm.listSellerDocuments(auth.token, vtexProductId, auth.sellerId)
    ctx.body = { success: true, documents, sellerId: auth.sellerId }
  } catch (err: any) {
    if (err?.response?.status === 404) {
      ctx.body = { success: false, error: 'not_linked', detail: err?.response?.data?.message }
      return
    }
    ctx.body = { success: false, error: 'Failed to load documents', detail: mdmErrDetail(err) }
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

// Splices a form field into a raw multipart body just before the closing
// boundary — used to inject vtex_seller_id server-side so the browser can
// never spoof another seller's identity.
function appendMultipartField(body: Buffer, boundary: string, name: string, value: string): Buffer {
  const closing = Buffer.from(`--${boundary}--`)
  const idx = body.lastIndexOf(closing)
  if (idx === -1) return body
  const field = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  )
  return Buffer.concat([body.slice(0, idx), field, body.slice(idx)])
}

export async function uploadSellerDocument(ctx: ServiceContext<Clients>) {
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

  let body = await readRawBody(ctx)
  if (!body.length) {
    ctx.body = { success: false, error: 'Empty upload body' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  body = appendMultipartField(body, boundary, 'vtex_seller_id', auth.sellerId)

  try {
    const res = await axios.post(
      `${auth.baseUrl}/vtex/products/${vtexProductId}/documents`,
      body,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json',
          'Content-Type': contentType,
        },
        maxBodyLength: Infinity,
        timeout: 20000,
      }
    )
    ctx.body = { success: true, document: res.data?.data ?? null }
  } catch (err: any) {
    if (err?.response?.status === 404) {
      ctx.body = { success: false, error: 'not_linked', detail: err?.response?.data?.message }
      return
    }
    ctx.body = { success: false, error: 'Upload failed', detail: mdmErrDetail(err) }
  }
}

export async function deleteSellerDocument(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const { documentId } = parsed
  if (!documentId) {
    ctx.body = { success: false, error: 'documentId is required' }
    return
  }

  const auth = await mdmAuth(ctx)
  if (!auth) return

  try {
    await ctx.clients.mdm.deleteSellerDocument(auth.token, Number(documentId), auth.sellerId)
    ctx.body = { success: true }
  } catch (err: any) {
    if (err?.response?.status === 403) {
      ctx.body = { success: false, error: 'You can only delete documents you uploaded.' }
      return
    }
    ctx.body = { success: false, error: 'Delete failed', detail: mdmErrDetail(err) }
  }
}
