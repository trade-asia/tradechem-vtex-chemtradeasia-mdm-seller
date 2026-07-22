# chemtradeasia-mdm-seller

VTEX IO app (`tradeasiab2b.chemtradeasia-mdm-seller`) providing seller-facing MDM tools inside the seller's own VTEX admin:

- **Documents** — upload/manage a seller's own SDS / TDS / MSDS PDFs against their MDM-linked products.
- **Subscription** — landing page for the seller's marketplace subscription. Reads the seller's current subscription (and invoice history) directly from **MDM's Subscriptions module** — MDM's system of record, not Stripe. If MDM has no subscription for this seller, shows MDM's available plans instead. Read-only for now — plan selection isn't wired to checkout yet. See [Subscription (MDM-backed)](#subscription-mdm-backed) below.
- **Embed Demo** — a standalone demo of paying via Stripe's embedded Payment Element without leaving the page. Talks to Stripe directly; **not connected to MDM**.
- **Catalog capture** — background sync of the seller's own catalog products into MDM (broadcaster event + manual trigger).

## Structure

```
admin/         Admin route + navigation registration
messages/      i18n strings
node/          Backend service (handlers, routes, MDM + Stripe integration)
react/         Admin UI pages (one component per admin route)
```

## Admin pages

| Path | Component | Purpose |
|---|---|---|
| `/admin/mdm-seller/documents` | `SellerDocuments` | Upload/manage SDS/TDS/MSDS docs, scoped to the logged-in seller |
| `/admin/mdm-seller/subscription` | `SellerSubscription` | Current subscription + invoices (or plan list), read from MDM — no Stripe wiring yet |
| `/admin/mdm-seller/subscription-embed` | `SellerSubscriptionEmbed` | Nav label "Embed Demo" — standalone Stripe Payment Element demo, unrelated to MDM |

Reached from the VTEX Admin sidebar under **MDM** (registered in `admin/navigation.json`).

For seller-facing instructions (not technical), see the **[User Guide](user-guide/getting-started.md)**:

- [Getting Started](user-guide/getting-started.md)
- [Managing Documents](user-guide/documents.md)
- [Subscription & Billing](user-guide/subscription.md)
- [FAQ / Troubleshooting](user-guide/faq.md)
- [Dev Settings (list/add/update/remove config)](user-guide/dev-settings.md) — technical, for whoever configures/deploys the app

## Backend routes

All routes are defined in `node/service.json` and mounted at `https://{account}.myvtex.com/_v/mdm-seller/...`. Seller identity is always `ctx.vtex.account` (the account this app is installed on) — **never** anything sent by the browser, even on routes marked `public: true`.

### Documents

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `GET` | `/_v/mdm-seller/products` | `getSellerProducts` (`sellerProductsHandler.ts`) | Product picker — linked products for this seller, filterable by `name`, `sku`, `cas_number`, paginated (`page`, `per_page`) |
| `GET` | `/_v/mdm-seller/countries` | `getSellerCountries` | Country list for the document "origin countries" picker |
| `GET` | `/_v/mdm-seller/documents?vtexProductId=...` | `getSellerDocuments` (`sellerDocumentsHandler.ts`) | List this seller's documents for a product |
| `POST` | `/_v/mdm-seller/documents?vtexProductId=...` | `uploadSellerDocument` | Upload a PDF (`multipart/form-data`: `file`, `type`, `display_name?`, `grade?`, `origin_countries[]?`) |
| `POST` | `/_v/mdm-seller/documents/delete` | `deleteSellerDocument` | Delete a document (`{ documentId }`) — MDM enforces the seller can only delete their own |

### Subscription (MDM-backed, read-only)

Powers the **Subscription** page.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `GET` | `/_v/mdm-seller/mdm-subscription` | `getMySubscription` (`mdmSubscriptionHandler.ts`) | This seller's current subscription **from MDM** (`GET {mdmApiEndpoint}/subscriptions?source=vtex&external_reference_id=...`) — `null` if none |
| `GET` | `/_v/mdm-seller/mdm-invoices` | `getMySubscriptionInvoices` | This seller's invoice history **from MDM** (`GET {mdmApiEndpoint}/subscriptions/invoices?source=vtex&external_reference_id=...`) — only fetched when a subscription exists |
| `GET` | `/_v/mdm-seller/mdm-plans` | `getMySubscriptionPlans` | Available plans **from MDM** (`GET {mdmApiEndpoint}/subscriptions/plans?source=vtex`), shown when the seller has no subscription yet |

None of these touch Stripe. See [Subscription (MDM-backed)](#subscription-mdm-backed) below for scope and open questions.

### Stripe (used by Embed Demo only)

`createSubscriptionCheckout` (redirect-to-Stripe-Checkout) is currently **not called by any page** — it was the old Subscription page's flow before that page was repointed at MDM. Left in place, unused, for whenever checkout gets wired back in.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `POST` | `/_v/mdm-seller/subscription/checkout` | `createSubscriptionCheckout` (`subscriptionHandler.ts`) | *(currently unused)* Creates a Stripe Checkout Session, `mode: subscription`. Body: `{ plan: "monthly"\|"yearly", name, email, company?, phone? }`. Returns `{ success, url }` — redirect the browser to `url`. **Price is always resolved server-side from settings; the client only controls `plan`.** |
| `POST` | `/_v/mdm-seller/subscription/webhook` | `stripeWebhookHandler` | Public Stripe webhook. Verifies `stripe-signature` against `stripeWebhookSecret`, then persists status to VBase on `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `GET` | `/_v/mdm-seller/subscription/status` | `getSubscriptionStatus` | Current Stripe subscription record (VBase) + configured plan pricing — used by Embed Demo |
| `POST` | `/_v/mdm-seller/subscription/embed/init` | `initEmbeddedSubscription` | Creates a Stripe Customer + Subscription in `default_incomplete` status via the Subscriptions API (not Checkout Sessions), returns `{ clientSecret, publishableKey, subscriptionId }` for the browser to mount Stripe's Payment Element and confirm payment inline. Used by Embed Demo. |

### Catalog capture

| Method | Path | Handler | Purpose |
|---|---|---|---|
| — (event) | broadcaster `catalogChange` | `catalogCapture` (`productCaptureHandler.ts`) | Fires on catalog changes; pulls the changed product from the Seller Portal Catalog API and upserts it into MDM as `pending` |
| `GET` | `/_v/mdm-seller/capture?productId=...` | `manualCapture` | Manually trigger the same capture for one product (uses the logged-in admin user's token) |
| `GET` | `/_v/mdm-seller/my-products` | `listMyProducts` | This seller's captured-product queue (VBase-backed) |
| `GET` | `/_v/mdm-seller/capture-events` | `captureEventLog` | Diagnostics — last 30 capture events |

### Dev-only

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `GET` | `/_v/mdm-seller/dev/settings?secret=...` | `devReadSettings` (`devSettingsHandler.ts`) | List current config (sensitive fields masked) |
| `POST` | `/_v/mdm-seller/dev/settings` | `devSaveSettings` | Add/update config — merges into what's saved |
| `DELETE` | `/_v/mdm-seller/dev/settings` | `devDeleteSettings` | Remove specific config keys |

See [Settings](#settings) below and the full [Dev Settings guide](user-guide/dev-settings.md).

## MDM API

Base URL defaults to `https://tradeasia.exchange/api/v1` (overridable via the `mdmApiEndpoint` setting). Response envelope: `{ success, statusCode, message, data, errors }`.

| Method | Endpoint | Used for |
|---|---|---|
| `POST` | `/user/token` | Authenticate (`email` + `password`) → `{ token, expires_at }` |
| `GET` | `/vtex/products?vtex_linked=1&vtex_seller_id=...` | Linked products for this seller (filters: `name`, `sku`, `cas_number`; paginated) |
| `POST` | `/vtex/products` | Upsert a product (catalog capture flush) |
| `GET` | `/config/countries` | Country list |
| `GET` | `/vtex/products/{vtexProductId}/documents?vtex_seller_id=...` | List this seller's documents for a product |
| `POST` | `/vtex/products/{vtexProductId}/documents` | Upload a document (multipart; `vtex_seller_id` is spliced into the body server-side, never trusted from the browser) |
| `DELETE` | `/vtex/documents/{documentId}` | Delete a document (body: `{ vtex_seller_id }`) |

All calls carry `Authorization: Bearer {token}`. Tokens are obtained via `getMdmToken()` (`node/helpers/getMdmToken.ts`), which authenticates once and caches the token in VBase (see below), refreshing when less than 24h of validity remains, or immediately on a `401`.

## Settings

Defined in `manifest.json` → `settingsSchema`:

| Key | Purpose |
|---|---|
| `mdmApiEndpoint` | Base URL of the MDM API (defaults to `https://tradeasia.exchange/api/v1` if empty) |
| `mdmUsername` / `mdmPassword` | MDM login used to obtain a bearer token |
| `stripeSecretKey` | Stripe secret key (`sk_test_...` / `sk_live_...`) — used by Embed Demo (the Subscription page is MDM-backed and doesn't touch Stripe yet) |
| `stripePublishableKey` | Stripe publishable key (`pk_test_...` / `pk_live_...`) — used only by Embed Demo to mount the Payment Element client-side |
| `stripeWebhookSecret` | Signing secret (`whsec_...`) for the subscription webhook |
| `stripeMonthlyAmountUsd` / `stripeYearlyAmountUsd` | Plan prices in USD — default to `25` / `250` if unset |

### How settings get saved

**Production path:** VTEX Admin → Apps → this app → Settings, which VTEX persists and the app reads via `ctx.clients.apps.getAppSettings(appId)`.

**Dev-only fallback (currently in use):** this seller edition has no Apps admin UI to reach that screen, and the app's own token can't write its own settings (`403`). `readMdmConfig()` (`node/handlers/devSettingsHandler.ts`) therefore falls back to a VBase-stored config when real settings are empty, managed via `GET`/`POST`/`DELETE` on `/_v/mdm-seller/dev/settings` (list / add-or-update-by-merge / remove-by-key). Full reference with examples: **[Dev Settings guide](user-guide/dev-settings.md)**.

⚠️ The secret is hardcoded in source (`mdm-dev-2026`). Remove `devSettingsHandler.ts` and its route (`devSettings` in `service.json`) once real Settings access is available, before publishing to production.

### VBase buckets

| Bucket | Key | Contents |
|---|---|---|
| `dev-config` | `mdm` | Dev fallback settings blob (see above) |
| `mdm-auth` | `token` | Cached MDM bearer token + expiry |
| `mdm-subscription` | `status` | Current Stripe subscription record for this seller (`status`, `plan`, `email`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`) |
| `mdm-subscription` | `stripe-products` | `{ monthly: productId, yearly: productId }` — Stripe Product ids created lazily by the embedded flow (Subscriptions API needs an existing Product, unlike Checkout Sessions) and cached to avoid recreating them on every checkout |
| `mdmq` | `p{productId}`, `index`, `event-log` | Catalog-capture queue: per-product capture state, an index of captured product ids, and a rolling event log (last 30) |

## Stripe embedded checkout (Embed Demo)

Standalone demo, not wired to MDM. Guarantees the amount charged is always resolved server-side from settings — the browser only ever sends `plan`.

1. Seller fills the form on `/admin/mdm-seller/subscription-embed` and clicks **Continue to payment**.
2. Browser `POST`s to `/_v/mdm-seller/subscription/embed/init`. The backend finds-or-creates a Stripe Customer by email, lazily creates (and caches) a Stripe Product per plan, then creates a Subscription in `default_incomplete` status via the **Subscriptions API** (not Checkout Sessions — that API doesn't support ad-hoc `product_data`, only an existing Product id) with `expand: ['latest_invoice.payment_intent']`, and returns that PaymentIntent's `clientSecret` plus the `publishableKey`.
3. The browser loads Stripe.js (`https://js.stripe.com/v3/`) at runtime, mounts a Payment Element using the `clientSecret`, and on submit calls `stripe.confirmPayment({ redirect: 'if_required' })` — for most cards this completes without ever leaving the page; redirect-requiring methods (e.g. 3D Secure) still bounce out and back via `return_url`.
4. Stripe's `customer.subscription.updated` webhook event (fired when the subscription moves from `incomplete` to `active`) persists the record to VBase — the webhook handler reads `name`/`email`/`company`/`phone`/`plan` from the **Subscription's own metadata** (set at creation).
5. The page polls `/_v/mdm-seller/subscription/status` to show the current status badge (Active / Past due / Canceled / none) and renewal date.

> ⚠️ Loading `js.stripe.com` inside the VTEX Admin iframe depends on VTEX's CSP allowing it — this hasn't been confirmed by an actual browser test. If the Payment Element fails to mount, check the browser console for a CSP violation first.

The redirect-to-Stripe-Checkout flow (`createSubscriptionCheckout`) still exists server-side but isn't called by any page right now — see the note in [Backend routes](#backend-routes) above.

### Configuring the webhook

In the Stripe Dashboard (or CLI), add an endpoint:

```
https://{account}.myvtex.com/_v/mdm-seller/subscription/webhook
```

Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the generated signing secret into `stripeWebhookSecret`.

## Subscription (MDM-backed)

Per MDM's own integration guide (`docs/vtex-subscriptions-integration-guide.html` in the MDM repo): **MDM never talks to Stripe directly** — VTEX's billing engine owns checkout, MDM is the system of record VTEX reports into and reads back from. The **Subscription** page (`/admin/mdm-seller/subscription`) is the first, read-only step toward that: it shows what MDM currently knows about this seller, sourced from MDM's own Subscriptions module, not from Stripe or this app's own VBase status.

**Current scope — seller side only, read-only:**

1. `GET /_v/mdm-seller/mdm-subscription` → MDM's `GET /subscriptions?source=vtex&external_reference_id=...`. If found, the page shows the plan name, billing cycle, status, and renewal/cancellation date, **plus** invoice history via `GET /_v/mdm-seller/mdm-invoices` → MDM's `GET /subscriptions/invoices?...` (invoice ref, date, status, amount).
2. If MDM has no subscription for this seller, the page instead calls `GET /_v/mdm-seller/mdm-plans` → MDM's `GET /subscriptions/plans?source=vtex` and renders plan cards (name, description, features, price, a Monthly/Yearly toggle if applicable, a "Best value" ribbon on the recommended plan, a Contact Sales link for `pricing_mode: "contact"` plans). Priced plans show a **disabled** "Select plan" button — deliberately not wired to Stripe yet.
3. No manual name/email/company/phone form on this page — MDM's guide is explicit that a seller's profile should be pushed into MDM server-side (`POST /subscriptions/events` with just the `customer` block, at registration/profile-update time) rather than typed in ad hoc at checkout. That sync call **is not implemented yet** — this page currently only reads.

**Explicitly out of scope for now** (not implemented, not started): wiring the plan buttons to Stripe checkout, reporting checkout/renewal events back to MDM (`POST /subscriptions/events`), registering MDM's own separate Stripe webhook with the metadata keys it expects, the seller-profile sync call, and any VTEX Admin-side (marketplace-admin, cross-seller) Subscriptions/Billing screens — all of that is a later step, seller side only for now.

**Open questions before going further** (from reading MDM's guide):

- **`external_reference_id`** — MDM's guide calls this "the VTEX Seller ID" without defining it precisely. This app currently sends `ctx.vtex.account` (the VTEX account name). Needs confirming with the MDM team as the intended value — it may instead mean a marketplace-specific seller id distinct from the account name.
- **Auth — confirmed broken as currently implemented.** The code assumes the same MDM Bearer token used for Products/Documents (`mdmUsername`/`mdmPassword` → `/user/token`, cached — see `getSellerMdmToken()`) also covers `/subscriptions/*`, since it's the same API root. Live testing against the real MDM API returns `{"success":false,"detail":"Unauthenticated."}` on both `/subscriptions` and `/subscriptions/plans`. Needs the MDM team to confirm whether the Subscriptions module needs separate credentials/scope, or whether this MDM account simply doesn't have the module enabled yet.
- **Response envelope** — MDM's guide shows trimmed example payloads without a fully explicit top-level shape for `GET /subscriptions`, `GET /subscriptions/plans`, `GET /subscriptions/invoices`. The client methods defensively handle both a bare array and `{ data: [...] }` — not yet confirmed which it actually is, since every real call so far has failed auth before reaching a response body worth inspecting.

## Local development

```sh
vtex login <account>
vtex use <workspace>
vtex link
```

Requires the [VTEX Toolbelt](https://developers.vtex.com/docs/guides/vtex-io-documentation-vtex-toolbelt) (`vtex --version`).

Type-check the backend:

```sh
cd node && yarn install && yarn lint
```

## Outbound access

`manifest.json` policies allow outbound calls to `{account}.vtexcommercestable.com.br` (catalog), `tradeasia.exchange` (MDM), and a wildcard `*` host (covers `api.stripe.com` for the Stripe SDK) — plus `vbase-read-write` and `product-read`.
