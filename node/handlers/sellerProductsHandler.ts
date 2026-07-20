import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'
import { getMdmToken, clearMdmToken } from '../helpers/getMdmToken'
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

// Linked products the seller can attach documents to.
// NOTE: the UI needs each product's vtex_product_id — the MDM /vtex/products
// feed must expose it on linked products (add it there if missing).
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
