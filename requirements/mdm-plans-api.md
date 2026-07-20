# Requirement: MDM-Owned Subscription Plans API (with Stripe Product/Price)

**Requested by:** VTEX / Marketplace team
**Requested from:** MDM team
**Related to:** Seller Subscription feature in `chemtradeasia-mdm-seller` (VTEX seller admin)

## Problem

Today, the VTEX-side app defines subscription plans itself: a hardcoded "Monthly" / "Yearly" choice, with the price read from VTEX app settings (`stripeMonthlyAmountUsd` / `stripeYearlyAmountUsd`). When a seller checks out, VTEX creates the Stripe Product **on the fly**, at checkout time, if one isn't already cached.

This has two real problems we've hit in testing:

1. **No single source of truth for plans.** Changing a price, adding a new plan (e.g. quarterly, a discounted tier, a one-time setup fee) requires editing VTEX app settings or code — MDM has no visibility into or control over what's actually for sale.
2. **Duplicate Stripe Products.** Because the Stripe Product is created lazily by VTEX and only cached best-effort, any hiccup in that caching (which happened during our own testing) silently creates a **new** Stripe Product on every single checkout instead of reusing one. There's no reason VTEX should be the system creating Stripe catalog objects at all — it should just be checking out against plans that already exist.

## Ask

Add a **Plans API** to MDM that owns the full lifecycle of subscription plans, including their Stripe Product/Price, so VTEX only ever needs to fetch a plan list and pass through the price id it's given — never create Stripe Products itself.

### 1. Plan data model (MDM side)

Each plan should store at least:

| Field | Notes |
|---|---|
| `id` | MDM's own plan id |
| `name` | Display name, e.g. "Monthly", "Yearly", or something more descriptive |
| `interval` | `month` / `year` (whatever billing intervals MDM wants to support) |
| `amount` | Price, in the smallest currency unit (cents) to avoid float rounding issues |
| `currency` | e.g. `usd` |
| `status` | `active` / `archived` |
| `stripe_product_id` | Set by MDM when the plan is created |
| `stripe_price_id` | Set by MDM when the plan is created |

### 2. On plan create

When an MDM admin creates a plan:

1. MDM's backend calls the Stripe API **server-side** to create a `Product`, then a recurring `Price` on that product (amount, currency, interval as entered).
2. Store the returned `stripe_product_id` and `stripe_price_id` on the plan record.
3. The plan is now visible via the Plans API (below) for VTEX (and any other consumer) to check out against.

### 3. On plan edit (price change)

Stripe **Prices are immutable** — you can't change an existing Price's amount. When a plan's price changes:

1. Create a **new** Stripe Price on the same Product.
2. Deactivate the old Price (`active: false`) so it can no longer be used for new checkouts.
3. Update the plan's `stripe_price_id` to the new Price id.
4. **Existing subscribers should stay on their original price** — this is standard Stripe behavior (existing Subscriptions keep referencing their original Price object even after it's deactivated) and requires no special handling beyond not touching already-created Subscriptions.

### 4. On plan delete/archive

1. Deactivate the Stripe Product and/or Price (`active: false`) — **do not hard-delete** them in Stripe if any customer has ever subscribed to that price (Stripe will reject deleting a Product with Prices attached to it, and existing subscriptions need the Price to remain resolvable).
2. Mark the plan `status: archived` in MDM's DB.
3. Archived plans should stop appearing in the Plans API's default (active-only) list, but ideally remain fetchable by id for historical/reporting purposes.

### 5. Plans API (what VTEX will call)

A public/authenticated `GET` endpoint returning the active plans, e.g.:

```
GET /vtex/subscription-plans
```

```json
{
  "success": true,
  "data": [
    {
      "id": "plan_monthly",
      "name": "Monthly",
      "interval": "month",
      "amount": 2500,
      "currency": "usd",
      "stripe_price_id": "price_1AbCdEfGhIjKlMn",
      "status": "active"
    },
    {
      "id": "plan_yearly",
      "name": "Yearly",
      "interval": "year",
      "amount": 25000,
      "currency": "usd",
      "stripe_price_id": "price_1XyZaBcDeFgHiJk",
      "status": "active"
    }
  ]
}
```

The exact field names/route don't need to match this — matching MDM's existing API conventions (envelope shape, auth) is preferred. The one field that matters most is **`stripe_price_id`** — once VTEX has that, checkout becomes a straight pass-through: `stripe.checkout.sessions.create({ line_items: [{ price: stripe_price_id, quantity: 1 }], mode: 'subscription', ... })`, with no Product/Price creation logic left on the VTEX side at all.

### 6. Stripe account coordination (important)

The Stripe Products/Prices MDM creates must live in the **same Stripe account and mode (test vs. live)** that VTEX's checkout is configured against — a price id from a different Stripe account won't resolve. We should confirm together:

- Which team holds the Stripe account credentials used for these API calls (recommend MDM owns the secret key used to create Products/Prices, since MDM now owns plan lifecycle).
- How test-mode vs. live-mode plans are kept separate (e.g. MDM's staging environment creates plans in Stripe test mode, production creates in live mode) so VTEX's dev/staging workspace and production workspace each resolve against the matching Stripe mode.

## What changes on the VTEX side once this exists

`subscriptionHandler.ts` (`createSubscriptionCheckout` / `initEmbeddedSubscription`) will be simplified to fetch the plan list from this new API and pass the returned `stripe_price_id` straight into Stripe's Checkout Session / Subscription creation, removing:
- The hardcoded monthly/yearly amounts in VTEX app settings.
- The `getOrCreateProductId` lazy-creation-and-caching logic entirely.

This also opens the door to more than two plans (tiers, add-ons, regional pricing, etc.) without any further VTEX-side code changes — new plans just need to exist in MDM.

## Open questions for MDM team

1. Who owns/holds the Stripe secret key used to create Products/Prices — MDM, or should VTEX continue to hold it and MDM just tells us the plan config to create ourselves?
2. Preferred endpoint path, auth mechanism, and response envelope, to match your existing API conventions.
3. Any additional plan attributes worth exposing now (e.g. a description/marketing copy field, trial period days, currency per region)?
