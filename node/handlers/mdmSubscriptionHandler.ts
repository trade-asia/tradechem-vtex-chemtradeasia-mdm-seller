import { ServiceContext } from '@vtex/api'
import Stripe from 'stripe'
import { Clients } from '../clients'
import { readBody } from '../helpers/readBody'
import { getVtexAdminUser } from '../helpers/getVtexAdminUser'
import { getSellerMdmToken, readMdmConfig } from './devSettingsHandler'

// Same short-bucket-name lesson as subscriptionHandler.ts — VBase prefixes
// bucket names with the app id and caps the combined length at 50 chars.
const STRIPE_PRODUCTS_BUCKET = 'mdmsub'
const STRIPE_PRODUCTS_KEY = 'mdm-stripe-products'

// Same MDM error-shape handling used elsewhere in this app.
function mdmErrDetail(err: any): string {
  const data = err?.response?.data
  if (!data) return err?.message ?? 'Unknown error'
  if (typeof data === 'string') return data
  if (data.message) return data.message
  try { return JSON.stringify(data) } catch { return err.message }
}

// The "VTEX Seller ID" MDM's Subscriptions API expects as
// external_reference_id. Using the VTEX account name for now — confirm with
// the MDM team this is the intended identity, not a separate marketplace
// seller id.
function externalReferenceId(ctx: ServiceContext<Clients>): string {
  return ctx.vtex.account
}

// MDM's guide: "this is also how a seller gets into MDM in the first place
// ... call this with only the customer block whenever a seller registers or
// updates their profile on VTEX, independent of whether they ever buy a
// plan." Idempotent on (source, external_reference_id), so it's safe/simple
// to call on every page load rather than tracking whether we already synced.
// Best-effort — a sync failure shouldn't block the page from loading.
async function syncSellerToMdm(ctx: ServiceContext<Clients>, token: string): Promise<void> {
  const { email } = getVtexAdminUser(ctx)
  if (!email) return
  try {
    await ctx.clients.mdm.reportSubscriptionEvent(token, {
      source: 'vtex',
      customer: {
        external_reference_id: externalReferenceId(ctx),
        customer_group_type: 'seller',
        email,
      },
    })
  } catch (err: any) {
    console.error('[mdmSubscriptionHandler] seller sync to MDM failed:', mdmErrDetail(err))
  }
}

// GET /_v/mdm-seller/mdm-subscription — this seller's current subscription
// from MDM (system of record), not from our own VBase/Stripe status.
export async function getMySubscription(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const token = await getSellerMdmToken(ctx)
  if (!token) {
    ctx.body = { success: false, error: 'MDM is not configured for this seller yet.' }
    return
  }

  await syncSellerToMdm(ctx, token)

  try {
    const subscription = await ctx.clients.mdm.getSubscription(token, externalReferenceId(ctx))
    ctx.body = { success: true, subscription }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load subscription from MDM', detail: mdmErrDetail(err) }
  }
}

// GET /_v/mdm-seller/mdm-plans — available plans to show when this seller
// has no active subscription yet.
export async function getMySubscriptionPlans(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const token = await getSellerMdmToken(ctx)
  if (!token) {
    ctx.body = { success: false, error: 'MDM is not configured for this seller yet.' }
    return
  }

  try {
    const plans = await ctx.clients.mdm.getSubscriptionPlans(token)
    ctx.body = { success: true, plans }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load plans from MDM', detail: mdmErrDetail(err) }
  }
}

// GET /_v/mdm-seller/mdm-invoices — this seller's invoice history from MDM,
// shown alongside their subscription details when one exists.
export async function getMySubscriptionInvoices(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const token = await getSellerMdmToken(ctx)
  if (!token) {
    ctx.body = { success: false, error: 'MDM is not configured for this seller yet.' }
    return
  }

  try {
    const invoices = await ctx.clients.mdm.getSubscriptionInvoices(token, externalReferenceId(ctx))
    ctx.body = { success: true, invoices }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to load invoices from MDM', detail: mdmErrDetail(err) }
  }
}

// Unlike Checkout Sessions, the Subscriptions API's inline price_data only
// accepts an existing Product id (no product_data) — so the product is
// created once per MDM plan+billing-cycle and its id cached in VBase.
async function getOrCreateProductId(
  ctx: ServiceContext<Clients>,
  stripe: Stripe,
  planId: string,
  billingCycleId: string,
  productName: string
): Promise<string> {
  const cacheKey = `${planId}:${billingCycleId}`
  let cache: Record<string, string> = {}
  try {
    cache = (await ctx.clients.vbase.getJSON<Record<string, string>>(STRIPE_PRODUCTS_BUCKET, STRIPE_PRODUCTS_KEY, true)) ?? {}
  } catch (err: any) {
    console.error('[mdmSubscriptionHandler] failed to read cached Stripe product ids from VBase:', err?.message)
  }

  if (cache[cacheKey]) {
    try {
      const existing = await stripe.products.retrieve(cache[cacheKey])
      if (existing?.active !== false) return cache[cacheKey]
    } catch {
      // cached id no longer resolves — fall through and recreate it
    }
  }

  const product = await stripe.products.create({ name: productName })
  cache[cacheKey] = product.id
  try {
    await ctx.clients.vbase.saveJSON(STRIPE_PRODUCTS_BUCKET, STRIPE_PRODUCTS_KEY, cache)
  } catch (err: any) {
    console.error('[mdmSubscriptionHandler] failed to cache Stripe product id in VBase:', err?.message)
  }
  return product.id
}

// POST /_v/mdm-seller/subscription/mdm-checkout
// Real checkout, backed by MDM's actual plans (never our own hardcoded
// pricing). The browser only ever sends planId/billingCycleId — no email or
// name. Identity comes from the logged-in VTEX admin user's own token
// (getVtexAdminUser), never typed in ad hoc, and the price is always
// re-resolved server-side from MDM's plans response.
//
// Uses the Subscriptions API directly (like the Embed Demo page) rather than
// a Checkout Session redirect, specifically so the Stripe subscription id is
// known synchronously in this same request — that's what lets us report the
// new subscription to MDM (POST /subscriptions/events) right here, with no
// need for our own webhook in the loop. From this point on, MDM's own
// separate Stripe webhook (Stripe -> MDM directly, registered in the Stripe
// Dashboard pointing at MDM's URL) handles every status change/renewal on
// its own — see docs/vtex-subscriptions-integration-guide.html (MDM repo).
export async function initMdmSubscriptionCheckout(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const planId = parsed.planId
  const billingCycleId = parsed.billingCycleId

  if (!planId || !billingCycleId) {
    ctx.body = { success: false, error: 'planId and billingCycleId are required.' }
    return
  }

  const { email } = getVtexAdminUser(ctx)
  if (!email) {
    ctx.body = { success: false, error: 'Could not determine your account email. Contact the marketplace administrator.' }
    return
  }

  const token = await getSellerMdmToken(ctx)
  if (!token) {
    ctx.body = { success: false, error: 'MDM is not configured for this seller yet.' }
    return
  }

  const config = await readMdmConfig(ctx)
  if (!config?.stripeSecretKey || !config?.stripePublishableKey) {
    ctx.body = { success: false, error: 'Stripe is not fully configured for this seller yet.' }
    return
  }

  // Server-side price lookup — re-fetch MDM's plans and find the exact
  // billing cycle the seller picked. Never trust a client-sent amount.
  let plan: any
  let cycle: any
  try {
    const plans = await ctx.clients.mdm.getSubscriptionPlans(token)
    plan = plans.find((p: any) => String(p.id) === String(planId))
    cycle = plan?.billing_cycles?.find((c: any) => String(c.id) === String(billingCycleId))
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to verify plan with MDM', detail: mdmErrDetail(err) }
    return
  }
  if (!plan || !cycle) {
    ctx.body = { success: false, error: 'That plan/billing cycle was not found.' }
    return
  }

  const stripe = new Stripe(config.stripeSecretKey)
  const amount = Number(cycle.effective_price ?? cycle.price)
  const currency = String(cycle.currency ?? 'USD').toLowerCase()
  const interval: 'month' | 'year' = cycle.interval === 'year' ? 'year' : 'month'

  // Required MDM metadata keys, exact names — this is the only way MDM's own
  // webhook can attribute a Stripe event to a seller later. display_name is
  // optional per MDM's guide and we don't have a reliable one from the VTEX
  // admin token anyway (only email); email lives on the Stripe Customer
  // object directly, so it's left out of metadata too.
  const metadata = {
    source: 'vtex',
    external_reference_id: externalReferenceId(ctx),
    customer_group_type: 'seller',
    mdm_plan_id: String(planId),
    mdm_billing_cycle_id: String(billingCycleId),
  }

  try {
    const existingCustomers = await stripe.customers.list({ email, limit: 1 })
    const customer =
      existingCustomers.data[0] ??
      (await stripe.customers.create({ email, metadata }))

    const productId = await getOrCreateProductId(ctx, stripe, String(planId), String(billingCycleId), `${plan.name} — ${cycle.label}`)

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency,
            unit_amount: Math.round(amount * 100),
            recurring: { interval },
            product: productId,
          },
        },
      ],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata,
    })

    const invoice = subscription.latest_invoice as any
    const paymentIntent = invoice && typeof invoice === 'object' ? invoice.payment_intent : null
    const clientSecret = paymentIntent && typeof paymentIntent === 'object' ? paymentIntent.client_secret : null

    if (!clientSecret) {
      ctx.body = { success: false, error: 'Stripe did not return a payment intent for this subscription.' }
      return
    }

    // Report the new subscription to MDM synchronously, right here — this is
    // what actually creates the record in MDM (their webhook only updates an
    // existing one, it doesn't create from a bare Stripe event since it
    // needs plan_id, which only we know at this point).
    try {
      const firstItem = (subscription.items?.data?.[0] as any) ?? {}
      const periodStart = firstItem.current_period_start ?? (subscription as any).current_period_start
      const periodEnd = firstItem.current_period_end ?? (subscription as any).current_period_end

      await ctx.clients.mdm.reportSubscriptionEvent(token, {
        source: 'vtex',
        customer: {
          external_reference_id: externalReferenceId(ctx),
          customer_group_type: 'seller',
          email,
        },
        subscription: {
          plan_id: planId,
          billing_cycle_id: billingCycleId,
          status: subscription.status,
          external_subscription_id: subscription.id,
          external_customer_id: customer.id,
          current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : undefined,
          current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
        },
        invoice: invoice && typeof invoice === 'object' ? {
          external_invoice_id: invoice.id,
          amount: (invoice.amount_due ?? invoice.total ?? 0) / 100,
          currency: String(invoice.currency ?? currency).toUpperCase(),
          status: invoice.status === 'paid' ? 'paid' : 'pending',
        } : undefined,
      })
    } catch (err: any) {
      console.error('[mdmSubscriptionHandler] failed to report new subscription to MDM:', mdmErrDetail(err))
    }

    ctx.body = {
      success: true,
      clientSecret,
      publishableKey: config.stripePublishableKey,
      subscriptionId: subscription.id,
    }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to start checkout', detail: err?.message }
  }
}
