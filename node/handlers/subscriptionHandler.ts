import { ServiceContext } from '@vtex/api'
import Stripe from 'stripe'
import { Clients } from '../clients'
import { readBody } from '../helpers/readBody'
import { readRawBody } from '../helpers/readRawBody'
import { readMdmConfig } from './devSettingsHandler'

// Kept short deliberately — VBase prefixes bucket names with the app id and
// caps the combined length at 50 chars. This app's id is long enough
// ("chemtradeasia-mdm-seller") that a longer bucket name like
// "mdm-subscription" silently 400s on every write (caught by the try/catch
// below, so it never surfaces as an error unless you're looking for it).
const VBASE_BUCKET = 'mdmsub'
const VBASE_KEY = 'status'

const DEFAULT_MONTHLY_USD = 25
const DEFAULT_YEARLY_USD = 250

type Plan = 'monthly' | 'yearly'

interface SubscriptionRecord {
  status: string
  plan: Plan
  name?: string
  email?: string
  company?: string
  phone?: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  currentPeriodEnd?: string
  updatedAt: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const STRIPE_PRODUCTS_BUCKET = VBASE_BUCKET
const STRIPE_PRODUCTS_KEY = 'stripe-products'

// Unlike Checkout Sessions, the Subscriptions API's inline price_data only
// accepts an existing Product id (no product_data) — so the product is
// created once per plan and its id cached in VBase for reuse.
async function getOrCreateProductId(ctx: ServiceContext<Clients>, stripe: Stripe, plan: Plan): Promise<string> {
  let cache: Record<string, string> = {}
  try {
    cache = (await ctx.clients.vbase.getJSON<Record<string, string>>(STRIPE_PRODUCTS_BUCKET, STRIPE_PRODUCTS_KEY, true)) ?? {}
  } catch (err: any) {
    console.error('[subscriptionHandler] failed to read cached Stripe product ids from VBase:', err?.message)
  }

  if (cache[plan]) {
    try {
      const existing = await stripe.products.retrieve(cache[plan])
      if (existing?.active !== false) return cache[plan]
    } catch {
      // cached id no longer resolves (e.g. deleted, or a different Stripe
      // account/key was swapped in) — fall through and recreate it
    }
  }

  const product = await stripe.products.create({
    name: `Seller Marketplace Subscription — ${plan === 'yearly' ? 'Yearly' : 'Monthly'}`,
  })
  cache[plan] = product.id
  try {
    await ctx.clients.vbase.saveJSON(STRIPE_PRODUCTS_BUCKET, STRIPE_PRODUCTS_KEY, cache)
  } catch (err: any) {
    console.error('[subscriptionHandler] failed to cache Stripe product id in VBase:', err?.message)
  }
  return product.id
}

interface StripeConfig {
  stripe: Stripe
  webhookSecret: string | undefined
  publishableKey: string | undefined
  monthlyUsd: number
  yearlyUsd: number
}

// Resolves Stripe credentials from app settings (falls back to the same
// VBase dev-config used for MDM credentials — see devSettingsHandler.ts).
// Returns null and writes an error response if the secret key is missing.
async function stripeConfig(ctx: ServiceContext<Clients>): Promise<StripeConfig | null> {
  const settings = await readMdmConfig(ctx)
  if (!settings?.stripeSecretKey) {
    ctx.body = { success: false, error: 'Stripe is not configured for this seller yet.' }
    return null
  }
  return {
    stripe: new Stripe(settings.stripeSecretKey),
    webhookSecret: settings.stripeWebhookSecret,
    publishableKey: settings.stripePublishableKey,
    monthlyUsd: Number(settings.stripeMonthlyAmountUsd) || DEFAULT_MONTHLY_USD,
    yearlyUsd: Number(settings.stripeYearlyAmountUsd) || DEFAULT_YEARLY_USD,
  }
}

// Creates a Stripe Checkout Session for the seller's chosen plan. The price
// is always resolved server-side from settings — plan is the only thing the
// browser controls, never the amount.
export async function createSubscriptionCheckout(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const plan: Plan = parsed.plan === 'yearly' ? 'yearly' : 'monthly'
  const name = String(parsed.name ?? '').trim()
  const email = String(parsed.email ?? '').trim()
  const company = String(parsed.company ?? '').trim()
  const phone = String(parsed.phone ?? '').trim()

  if (!name) {
    ctx.body = { success: false, error: 'Contact name is required.' }
    return
  }
  if (!email || !EMAIL_RE.test(email)) {
    ctx.body = { success: false, error: 'A valid email is required.' }
    return
  }

  const cfg = await stripeConfig(ctx)
  if (!cfg) return

  const amountUsd = plan === 'yearly' ? cfg.yearlyUsd : cfg.monthlyUsd
  const interval: 'month' | 'year' = plan === 'yearly' ? 'year' : 'month'
  const origin = ctx.get('origin') || `https://${ctx.vtex.account}.myvtex.com`

  try {
    const session = await cfg.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amountUsd * 100),
            recurring: { interval },
            product_data: {
              name: `Seller Marketplace Subscription — ${plan === 'yearly' ? 'Yearly' : 'Monthly'}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/admin/mdm-seller/subscription?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/admin/mdm-seller/subscription?status=cancel`,
      metadata: {
        vtex_seller_id: ctx.vtex.account,
        plan,
        name: name.slice(0, 200),
        company: company.slice(0, 200),
        phone: phone.slice(0, 50),
      },
      subscription_data: {
        metadata: { vtex_seller_id: ctx.vtex.account, plan },
      },
    })

    ctx.body = { success: true, url: session.url }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to start checkout', detail: err?.message }
  }
}

// Starts an embedded subscription: creates (or reuses) a Stripe Customer and
// a Subscription in `default_incomplete` status, then returns the client
// secret of its first invoice's PaymentIntent so the browser can mount
// Stripe's Payment Element and confirm payment without ever leaving this
// page. Same security property as the redirect flow: the browser only ever
// sends `plan`, the amount is always resolved server-side from settings.
export async function initEmbeddedSubscription(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const raw = await readBody(ctx)
  let parsed: any = {}
  try { parsed = JSON.parse(raw) } catch {}

  const plan: Plan = parsed.plan === 'yearly' ? 'yearly' : 'monthly'
  const name = String(parsed.name ?? '').trim()
  const email = String(parsed.email ?? '').trim()
  const company = String(parsed.company ?? '').trim()
  const phone = String(parsed.phone ?? '').trim()

  if (!name) {
    ctx.body = { success: false, error: 'Contact name is required.' }
    return
  }
  if (!email || !EMAIL_RE.test(email)) {
    ctx.body = { success: false, error: 'A valid email is required.' }
    return
  }

  const cfg = await stripeConfig(ctx)
  if (!cfg) return
  if (!cfg.publishableKey) {
    ctx.body = { success: false, error: 'Stripe publishable key is not configured for this seller yet.' }
    return
  }

  const amountUsd = plan === 'yearly' ? cfg.yearlyUsd : cfg.monthlyUsd
  const interval: 'month' | 'year' = plan === 'yearly' ? 'year' : 'month'
  const metadata = {
    vtex_seller_id: ctx.vtex.account,
    plan,
    name: name.slice(0, 200),
    email: email.slice(0, 200),
    company: company.slice(0, 200),
    phone: phone.slice(0, 50),
  }

  try {
    const existingCustomers = await cfg.stripe.customers.list({ email, limit: 1 })
    const customer =
      existingCustomers.data[0] ??
      (await cfg.stripe.customers.create({ email, name, phone: phone || undefined, metadata }))

    const productId = await getOrCreateProductId(ctx, cfg.stripe, plan)

    const subscription = await cfg.stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amountUsd * 100),
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

    const invoice = subscription.latest_invoice
    const paymentIntent = invoice && typeof invoice === 'object' ? (invoice as any).payment_intent : null
    const clientSecret = paymentIntent && typeof paymentIntent === 'object' ? paymentIntent.client_secret : null

    if (!clientSecret) {
      ctx.body = { success: false, error: 'Stripe did not return a payment intent for this subscription.' }
      return
    }

    ctx.body = {
      success: true,
      clientSecret,
      publishableKey: cfg.publishableKey,
      subscriptionId: subscription.id,
    }
  } catch (err: any) {
    ctx.body = { success: false, error: 'Failed to start embedded checkout', detail: err?.message }
  }
}

// Public Stripe webhook — no VTEX auth applies, so the seller identity comes
// from ctx.vtex.account (this service is deployed per-account, same trust
// model as the rest of the app) rather than anything in the payload.
export async function stripeWebhookHandler(ctx: ServiceContext<Clients>) {
  const settings = await readMdmConfig(ctx)
  if (!settings?.stripeSecretKey || !settings?.stripeWebhookSecret) {
    ctx.status = 500
    ctx.body = { received: false, error: 'Stripe webhook not configured' }
    return
  }

  const stripe = new Stripe(settings.stripeSecretKey)
  const signature = ctx.req.headers['stripe-signature'] as string | undefined
  const rawBody = await readRawBody(ctx)

  let event: Stripe.Event
  try {
    if (!signature) throw new Error('Missing stripe-signature header')
    event = stripe.webhooks.constructEvent(rawBody, signature, settings.stripeWebhookSecret)
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { received: false, error: `Signature verification failed: ${err?.message}` }
    return
  }

  ctx.status = 200

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const md = session.metadata ?? {}
      const record: SubscriptionRecord = {
        status: 'active',
        plan: md.plan === 'yearly' ? 'yearly' : 'monthly',
        name: md.name,
        email: session.customer_details?.email ?? session.customer_email ?? undefined,
        company: md.company,
        phone: md.phone,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        stripeSubscriptionId:
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
        updatedAt: new Date().toISOString(),
      }
      await ctx.clients.vbase.saveJSON(VBASE_BUCKET, VBASE_KEY, record)
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      let existing: SubscriptionRecord | null = null
      try { existing = await ctx.clients.vbase.getJSON<SubscriptionRecord>(VBASE_BUCKET, VBASE_KEY, true) } catch {}

      // The embedded flow (initEmbeddedSubscription) has no checkout.session
      // event to seed name/email/company/phone from, so this is often the
      // first event to populate them — read from the subscription's own
      // metadata (set at creation time) and only fall back to `existing`.
      const md = sub.metadata ?? {}
      const record: SubscriptionRecord = {
        ...(existing ?? ({} as SubscriptionRecord)),
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        plan: (md.plan === 'yearly' ? 'yearly' : md.plan === 'monthly' ? 'monthly' : existing?.plan) ?? 'monthly',
        name: md.name || existing?.name,
        email: md.email || existing?.email,
        company: md.company || existing?.company,
        phone: md.phone || existing?.phone,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : existing?.currentPeriodEnd,
        updatedAt: new Date().toISOString(),
      }
      await ctx.clients.vbase.saveJSON(VBASE_BUCKET, VBASE_KEY, record)
    }
  } catch (err: any) {
    // Persistence failures still ack 200 — Stripe retries on non-2xx and we
    // don't want a VBase hiccup to trigger a retry storm. Logged (rather than
    // fully swallowed) so a bad bucket name or similar doesn't fail silently
    // forever — see the VBASE_BUCKET comment above for the incident this
    // caught (17-char bucket name + this app's long id = a 400 on every
    // write, invisible until logged).
    console.error(`[subscriptionHandler] webhook persistence failed for ${event.type}:`, err?.message)
  }

  ctx.body = { received: true }
}

export async function getSubscriptionStatus(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  const settings = await readMdmConfig(ctx)
  const pricing = {
    monthlyUsd: Number(settings?.stripeMonthlyAmountUsd) || DEFAULT_MONTHLY_USD,
    yearlyUsd: Number(settings?.stripeYearlyAmountUsd) || DEFAULT_YEARLY_USD,
  }
  try {
    const record = await ctx.clients.vbase.getJSON<SubscriptionRecord>(VBASE_BUCKET, VBASE_KEY, true)
    ctx.body = { success: true, subscription: record ?? null, pricing }
  } catch {
    ctx.body = { success: true, subscription: null, pricing }
  }
}
