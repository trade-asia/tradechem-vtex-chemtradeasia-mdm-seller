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

export async function devSaveSettings(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const { secret, ...settings } = parsed
  if (secret !== DEV_SECRET) {
    ctx.body = { success: false, error: 'forbidden' }
    return
  }

  try {
    await ctx.clients.vbase.saveJSON(DEV_CONFIG_BUCKET, DEV_CONFIG_KEY, settings)
    ctx.body = { success: true, saved: Object.keys(settings) }
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
