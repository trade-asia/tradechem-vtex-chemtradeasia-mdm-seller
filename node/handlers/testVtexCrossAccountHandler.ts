import { ServiceContext } from '@vtex/api'
import axios from 'axios'
import { Clients } from '../clients'

const MDM_SHARED_CONFIG_TOKEN = '1942422|YVCvliBAkyJPwSRBBmKObwFaWuwVQIMfYOVoqu1pf6a8ba06'
const MARKETPLACE_ACCOUNT = 'tradeasiab2b'
const MARKER = '[v1-cross-account-test]'

// ⚠️ DEV/DIAGNOSTIC ONLY.
//
// GET /_v/mdm-seller/dev/test-vtex-cross-account
//
// Answers one question with a live, unambiguous result: once this seller
// app has the marketplace account's VTEX App Key/Token in hand (fetched via
// MDM's shared-config relay, which already works), can it actually USE them
// to call tradeasiab2b's own catalog API directly from this seller account's
// sandbox? That's a different network path than the shared-config fetch
// itself (which only talks to MDM, a host every app here reaches fine) —
// never actually exercised anywhere in this codebase (confirmed by grep: the
// fetched keys sit unused). This either confirms or rules out the
// cross-account TLS failure diagnosed on 2026-10-05 for this specific
// account pair, with a read-only, non-destructive call.
export async function testVtexCrossAccount(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const startedAt = Date.now()

  let keys: { vtexAppKey?: string; vtexAppToken?: string } = {}
  try {
    const data: any = await ctx.clients.mdm.getSharedVtexConfig(MDM_SHARED_CONFIG_TOKEN)
    keys = { vtexAppKey: data?.vtex_app_key, vtexAppToken: data?.vtex_app_token }
  } catch (err: any) {
    ctx.body = {
      marker: MARKER,
      step: 'fetch_shared_config',
      success: false,
      error: err?.message ?? 'unknown',
      elapsedMs: Date.now() - startedAt,
    }
    return
  }

  if (!keys.vtexAppKey || !keys.vtexAppToken) {
    ctx.body = { marker: MARKER, step: 'fetch_shared_config', success: false, error: 'No VTEX keys in shared config' }
    return
  }

  // Read-only, no product id required — category tree is always present.
  const url = `https://${MARKETPLACE_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/category/tree/1`
  try {
    const res = await axios.get(url, {
      headers: {
        'X-VTEX-API-AppKey': keys.vtexAppKey,
        'X-VTEX-API-AppToken': keys.vtexAppToken,
        Accept: 'application/json',
      },
      timeout: 15000,
    })
    ctx.body = {
      marker: MARKER,
      step: 'call_marketplace_catalog_api',
      success: true,
      status: res.status,
      categoriesReturned: Array.isArray(res.data) ? res.data.length : null,
      elapsedMs: Date.now() - startedAt,
      runningAccount: ctx.vtex.account,
      calledAccount: MARKETPLACE_ACCOUNT,
    }
  } catch (err: any) {
    ctx.body = {
      marker: MARKER,
      step: 'call_marketplace_catalog_api',
      success: false,
      status: err?.response?.status ?? null,
      error: err?.message ?? 'unknown',
      code: err?.code ?? null,
      detail: err?.response?.data ?? null,
      elapsedMs: Date.now() - startedAt,
      runningAccount: ctx.vtex.account,
      calledAccount: MARKETPLACE_ACCOUNT,
    }
  }
}
