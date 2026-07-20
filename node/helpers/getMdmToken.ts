import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'

const BUCKET = 'mdm-auth'
const TOKEN_KEY = 'token'

interface CachedToken {
  token: string
  expiresAt: string
}

export async function clearMdmToken(ctx: ServiceContext<Clients>): Promise<void> {
  try {
    await ctx.clients.vbase.saveJSON(BUCKET, TOKEN_KEY, null)
  } catch {}
}

export async function getMdmToken(
  ctx: ServiceContext<Clients>,
  email: string,
  password: string,
  force = false
): Promise<string> {
  if (!force) {
    let cached: CachedToken | null = null
    try {
      cached = await ctx.clients.vbase.getJSON<CachedToken>(BUCKET, TOKEN_KEY, true)
    } catch {}

    if (cached?.token && cached?.expiresAt) {
      const expiresAt = new Date(cached.expiresAt).getTime()
      if (expiresAt - Date.now() > 24 * 60 * 60 * 1000) {
        return cached.token
      }
    }
  }

  const { token, expiresAt } = await ctx.clients.mdm.authenticate(email, password)
  try {
    await ctx.clients.vbase.saveJSON(BUCKET, TOKEN_KEY, { token, expiresAt })
  } catch {}

  return token
}
