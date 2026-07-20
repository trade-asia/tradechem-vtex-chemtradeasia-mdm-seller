import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { readBody } from '../helpers/readBody'

// ⚠️ DEV ONLY — remove this handler and its route before `vtex publish`.
// Toolbelt 4.x dropped `vtex settings set` and the slim seller edition has no
// Apps admin UI, and the app token may not write its own settings (403) — so
// dev config lives in VBase and the handlers fall back to it.
const DEV_SECRET = 'mdm-dev-2026'

export const DEV_CONFIG_BUCKET = 'dev-config'
export const DEV_CONFIG_KEY = 'mdm'

// Fields whose values are never echoed back in full by devReadSettings.
const SENSITIVE_KEY_RE = /password|secret|token/i

function maskValue(value: any): any {
  if (typeof value !== 'string' || !value) return value
  const tail = value.length > 4 ? value.slice(-4) : value
  return `${'•'.repeat(8)}${tail} (set, ${value.length} chars)`
}

async function currentDevConfig(ctx: ServiceContext<Clients>): Promise<any> {
  try {
    return (await ctx.clients.vbase.getJSON<any>(DEV_CONFIG_BUCKET, DEV_CONFIG_KEY, true)) ?? {}
  } catch {
    return {}
  }
}

function checkSecret(ctx: ServiceContext<Clients>, secret: unknown): boolean {
  if (secret === DEV_SECRET) return true
  ctx.status = 200
  ctx.body = { success: false, error: 'forbidden' }
  return false
}

// List — GET /_v/mdm-seller/dev/settings?secret=...
// Sensitive fields (password/secret/token in the key name) are masked to the
// last 4 characters so you can confirm the right value is saved without it
// being fully readable over the wire.
export async function devReadSettings(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const secret = (ctx.query as any)?.secret
  if (!checkSecret(ctx, secret)) return

  const config = await currentDevConfig(ctx)
  const masked: any = {}
  for (const [key, value] of Object.entries(config)) {
    masked[key] = SENSITIVE_KEY_RE.test(key) ? maskValue(value) : value
  }
  ctx.body = { success: true, settings: masked }
}

// Add/Update — POST /_v/mdm-seller/dev/settings { secret, ...fieldsToSet }
// Merges into the existing saved config — fields you omit are left untouched.
// To remove a field entirely, use DELETE instead (see devDeleteSettings).
export async function devSaveSettings(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const { secret, ...updates } = parsed
  if (!checkSecret(ctx, secret)) return

  try {
    const existing = await currentDevConfig(ctx)
    const merged = { ...existing, ...updates }
    await ctx.clients.vbase.saveJSON(DEV_CONFIG_BUCKET, DEV_CONFIG_KEY, merged)
    ctx.body = { success: true, updated: Object.keys(updates), allKeys: Object.keys(merged) }
  } catch (err: any) {
    ctx.body = { success: false, error: err?.message }
  }
}

// Remove — DELETE /_v/mdm-seller/dev/settings { secret, keys: ["stripeSecretKey", ...] }
// Removes only the named fields; everything else stays as-is.
export async function devDeleteSettings(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const { secret, keys } = parsed
  if (!checkSecret(ctx, secret)) return
  if (!Array.isArray(keys) || !keys.length) {
    ctx.body = { success: false, error: 'keys (non-empty array) is required' }
    return
  }

  try {
    const existing = await currentDevConfig(ctx)
    for (const key of keys) delete existing[key]
    await ctx.clients.vbase.saveJSON(DEV_CONFIG_BUCKET, DEV_CONFIG_KEY, existing)
    ctx.body = { success: true, removed: keys, remainingKeys: Object.keys(existing) }
  } catch (err: any) {
    ctx.body = { success: false, error: err?.message }
  }
}

// Preferred auth: a per-seller MDM token (bound server-side to this seller's
// scope). Falls back to admin credentials + /user/token for dev only.
export async function getSellerMdmToken(ctx: any): Promise<string | null> {
  const config = await readMdmConfig(ctx)
  if (config?.mdmSellerToken) {
    if (config.mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(config.mdmApiEndpoint)
    return config.mdmSellerToken
  }
  if (config?.mdmUsername && config?.mdmPassword) {
    if (config.mdmApiEndpoint) ctx.clients.mdm.setBaseUrl(config.mdmApiEndpoint)
    const { getMdmToken } = await import('../helpers/getMdmToken')
    return getMdmToken(ctx, config.mdmUsername, config.mdmPassword)
  }
  return null
}

// Reads app settings, falling back to the VBase dev config
export async function readMdmConfig(ctx: ServiceContext<Clients>): Promise<any> {
  const appId = process.env.VTEX_APP_ID!
  let settings: any = {}
  try { settings = await ctx.clients.apps.getAppSettings(appId) } catch {}

  if (settings?.mdmSellerToken || (settings?.mdmUsername && settings?.mdmPassword)) return settings

  try {
    const devConfig = await ctx.clients.vbase.getJSON<any>(DEV_CONFIG_BUCKET, DEV_CONFIG_KEY, true)
    if (devConfig?.mdmSellerToken || devConfig?.mdmUsername) return devConfig
  } catch {}

  return settings ?? {}
}
