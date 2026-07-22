# chemtradeasia-mdm-seller

VTEX IO app (`tradeasiab2b.chemtradeasia-mdm-seller`) providing seller-facing MDM tools inside the seller's own VTEX admin:

- **Documents** — upload/manage a seller's own SDS / TDS / MSDS PDFs against their MDM-linked products.
- **Subscription** — the seller's marketplace subscription, backed by **MDM's Subscriptions module** — MDM's system of record, not our own VBase. Reads the seller's current subscription + invoice history if one exists; otherwise shows MDM's real plans with a working **Subscribe** button (Stripe's embedded Payment Element, no redirect, no manual email/name entry — identity comes from the logged-in VTEX admin user). See [Subscription (MDM-backed)](#subscription-mdm-backed) below.
- **Embed Demo** — a standalone demo of paying via Stripe's embedded Payment Element, using this app's own hardcoded pricing. Talks to Stripe directly; **not connected to MDM**. Kept as a working reference/fallback for the real flow.
- **Catalog capture** — background sync of the seller's own catalog products into MDM (broadcaster event + manual trigger).
- **Logs & Diagnostics** — a browsable index of every diagnostic/data endpoint in the app. See [Logs & Diagnostics guide](user-guide/logs-and-diagnostics.md).

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
| `/admin/mdm-seller/subscription` | `SellerSubscription` | Current subscription + invoices (from MDM), or plan list with a working Subscribe button |
| `/admin/mdm-seller/subscription-embed` | `SellerSubscriptionEmbed` | Nav label "Embed Demo" — standalone Stripe Payment Element demo, unrelated to MDM |

Reached from the VTEX Admin sidebar under **MDM** (registered in `admin/navigation.json`).

For seller-facing instructions (not technical), see the **[User Guide](user-guide/getting-started.md)**:

- [Getting Started](user-guide/getting-started.md)
- [Managing Documents](user-guide/documents.md)
- [Subscription & Billing](user-guide/subscription.md)
- [FAQ / Troubleshooting](user-guide/faq.md)
- [Dev Settings (list/add/update/remove config)](user-guide/dev-settings.md) — technical, for whoever configures/deploys the app
- [Logs & Diagnostics](user-guide/logs-and-diagnostics.md) — technical, browsable index of every diagnostic endpoint

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

### Subscription (MDM-backed — real checkout)

Powers the **Subscription** page. This is where money actually moves for real subscriptions.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `GET` | `/_v/mdm-seller/mdm-subscription` | `getMySubscription` (`mdmSubscriptionHandler.ts`) | This seller's current subscription **from MDM** (`GET {mdmApiEndpoint}/subscriptions?source=vtex&external_reference_id=...`) — `null` if none. Also pushes a seller-profile sync to MDM as a side effect (see below). |
| `GET` | `/_v/mdm-seller/mdm-invoices` | `getMySubscriptionInvoices` | This seller's invoice history **from MDM** (`GET {mdmApiEndpoint}/subscriptions/invoices?source=vtex&external_reference_id=...`) — only fetched when a subscription exists |
| `GET` | `/_v/mdm-seller/mdm-plans` | `getMySubscriptionPlans` | Available plans **from MDM** (`GET {mdmApiEndpoint}/subscriptions/plans?source=vtex`), shown when the seller has no subscription yet |
| `POST` | `/_v/mdm-seller/subscription/mdm-checkout` | `initMdmSubscriptionCheckout` | Body: `{ planId, billingCycleId }` — **that's all the browser sends**, no email/name/amount. Re-fetches MDM's plans server-side to resolve the real price, creates a Stripe Customer + Subscription directly (Subscriptions API, not Checkout Sessions), reports it to MDM synchronously (`POST /subscriptions/events`), and returns `{ clientSecret, publishableKey, subscriptionId }` for the browser to mount the Payment Element. See [Real checkout flow](#real-checkout-flow-subscription-page) below. |

See [Subscription (MDM-backed)](#subscription-mdm-backed) below for the full flow, architecture, and remaining open questions.

### Stripe — Embed Demo only

Separate from the flow above. Guarantees the amount charged is always resolved server-side from settings — the browser only ever sends `plan`.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `POST` | `/_v/mdm-seller/subscription/checkout` | `createSubscriptionCheckout` (`subscriptionHandler.ts`) | *(currently unused by any page)* Redirect-to-Stripe-Checkout flow. Left in place, unused. |
| `POST` | `/_v/mdm-seller/subscription/webhook` | `stripeWebhookHandler` | **Our own** public Stripe webhook (a separate destination from MDM's — see [Configuring the webhooks](#configuring-the-webhooks)). Verifies `stripe-signature` against `stripeWebhookSecret`, then persists status to VBase on `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Used by Embed Demo's status badge. |
| `GET` | `/_v/mdm-seller/subscription/status` | `getSubscriptionStatus` | Current Stripe subscription record (VBase) + configured plan pricing — used by Embed Demo |
| `POST` | `/_v/mdm-seller/subscription/embed/init` | `initEmbeddedSubscription` | Creates a Stripe Customer + Subscription in `default_incomplete` status via the Subscriptions API, returns `{ clientSecret, publishableKey, subscriptionId }`. Used by Embed Demo. |

### Catalog capture

| Method | Path | Handler | Purpose |
|---|---|---|---|
| — (event) | broadcaster `catalogChange` | `catalogCapture` (`productCaptureHandler.ts`) | Fires on catalog changes; pulls the changed product from the Seller Portal Catalog API and upserts it into MDM as `pending` |
| `GET` | `/_v/mdm-seller/capture?productId=...` | `manualCapture` | Manually trigger the same capture for one product (uses the logged-in admin user's token) |
| `GET` | `/_v/mdm-seller/my-products` | `listMyProducts` | This seller's captured-product queue (VBase-backed) |
| `GET` | `/_v/mdm-seller/capture-events` | `captureEventLog` | Diagnostics — last 30 capture events |

### Diagnostics

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `GET` | `/_v/mdm-seller/logs` | `logsHub` (`logsHubHandler.ts`) | Self-contained HTML page indexing every diagnostic/data endpoint in this app plus links to the marketplace app's own hub and MDM's live log viewer. See [Logs & Diagnostics guide](user-guide/logs-and-diagnostics.md). |
| `GET` | `/_v/mdm-seller/debug-admin-token` | `debugAdminToken` (`debugAdminTokenHandler.ts`) | Is a logged-in admin session present on this request? Decodes and reports its expiry — the credential manual `capture` and MDM-checkout email derivation both depend on. |

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
| `GET` | `/subscriptions?source=vtex&external_reference_id=...` | This seller's subscription (see [Subscription (MDM-backed)](#subscription-mdm-backed)) |
| `GET` | `/subscriptions/invoices?source=vtex&external_reference_id=...` | This seller's invoice history |
| `GET` | `/subscriptions/plans?source=vtex` | Available plans + billing cycles |
| `POST` | `/subscriptions/events` | The single ingestion endpoint for everything: new subscriptions, status updates, and the seller-profile-only sync (`customer` block, no `subscription`/`invoice`) |

All calls carry `Authorization: Bearer {token}`. Tokens are obtained via `getMdmToken()` (`node/helpers/getMdmToken.ts`), which authenticates once and caches the token in VBase (see below), refreshing when less than 24h of validity remains, or immediately on a `401`. The three `/subscriptions/*` GET calls also pass `cacheable: CacheType.None` explicitly — see the comment in `MdmClient.ts` for why (a real incident: `@vtex/api`'s HTTP client caches GET responses by URL only, so a stale 401 got served back regardless of which token was sent afterward).

## Settings

Defined in `manifest.json` → `settingsSchema`:

| Key | Purpose |
|---|---|
| `mdmApiEndpoint` | Base URL of the MDM API (defaults to `https://tradeasia.exchange/api/v1` if empty) |
| `mdmUsername` / `mdmPassword` | MDM login used to obtain a bearer token |
| `stripeSecretKey` | Stripe secret key (`sk_test_...` / `sk_live_...`) — used by both the real Subscription checkout and Embed Demo |
| `stripePublishableKey` | Stripe publishable key (`pk_test_...` / `pk_live_...`) — used by both, to mount the Payment Element client-side |
| `stripeWebhookSecret` | Signing secret (`whsec_...`) for **our own** webhook only (Embed Demo's status badge). MDM registers a separate destination directly with MDM, whose secret we never see — see [Configuring the webhooks](#configuring-the-webhooks). |
| `stripeMonthlyAmountUsd` / `stripeYearlyAmountUsd` | Plan prices in USD, **Embed Demo only** — default to `25` / `250` if unset. The real Subscription page prices plans from MDM directly. |

Removed: `mdmSellerToken` (a pre-issued, seller-scoped MDM token, preferred over `mdmUsername`/`mdmPassword` if set) existed briefly and was dropped — every MDM call is already scoped by an explicit `vtex_seller_id`/`external_reference_id` parameter, so it added no real isolation, and a stale saved value caused a real bug (the Subscription page failing with "Unauthenticated" against the Subscriptions module specifically, while the same MDM account worked fine elsewhere via `mdmUsername`/`mdmPassword`).

### How settings get saved

**Production path:** VTEX Admin → Apps → this app → Settings, which VTEX persists and the app reads via `ctx.clients.apps.getAppSettings(appId)`.

**Dev-only fallback (currently in use):** this seller edition has no Apps admin UI to reach that screen, and the app's own token can't write its own settings (`403`). `readMdmConfig()` (`node/handlers/devSettingsHandler.ts`) therefore falls back to a VBase-stored config when real settings are empty, managed via `GET`/`POST`/`DELETE` on `/_v/mdm-seller/dev/settings` (list / add-or-update-by-merge / remove-by-key). Full reference with examples: **[Dev Settings guide](user-guide/dev-settings.md)**.

⚠️ The secret is hardcoded in source (`mdm-dev-2026`). Remove `devSettingsHandler.ts` and its route (`devSettings` in `service.json`) once real Settings access is available, before publishing to production.

### VBase buckets

| Bucket | Key | Contents |
|---|---|---|
| `dev-config` | `mdm` | Dev fallback settings blob (see above) |
| `mdm-auth` | `token` | Cached MDM bearer token + expiry |
| `mdmsub` | `status` | Current Stripe subscription record for **Embed Demo only** (`status`, `plan`, `email`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`) |
| `mdmsub` | `stripe-products` | `{ monthly: productId, yearly: productId }` — Embed Demo's Stripe Product ids, cached to avoid recreating on every checkout |
| `mdmsub` | `mdm-stripe-products` | `{ "{planId}:{billingCycleId}": productId, ... }` — the real Subscription page's equivalent cache, keyed by MDM's actual plan/cycle ids instead of a fixed "monthly"/"yearly" string |
| `mdmq` | `p{productId}`, `index`, `event-log` | Catalog-capture queue: per-product capture state, an index of captured product ids, and a rolling event log (last 30) |

> Bucket name `mdmsub` (not `mdm-subscription`) is deliberate — VBase prefixes bucket names with the app id and caps the combined length at 50 chars. This app's id (`chemtradeasia-mdm-seller`) is long enough that `mdm-subscription` silently 400'd on every write, invisible until logged (see `mdmSubscriptionHandler.ts` and `subscriptionHandler.ts` for the incident notes).

## Stripe — Embed Demo

Standalone demo, not wired to MDM, using this app's own hardcoded `stripeMonthlyAmountUsd`/`stripeYearlyAmountUsd` settings.

1. Seller fills the form on `/admin/mdm-seller/subscription-embed` and clicks **Continue to payment**.
2. Browser `POST`s to `/_v/mdm-seller/subscription/embed/init`. The backend finds-or-creates a Stripe Customer by email, lazily creates (and caches) a Stripe Product per plan, then creates a Subscription in `default_incomplete` status via the **Subscriptions API** (not Checkout Sessions — that API doesn't support ad-hoc `product_data`, only an existing Product id) with `expand: ['latest_invoice.payment_intent']`, and returns that PaymentIntent's `clientSecret` plus the `publishableKey`.
3. The browser loads Stripe.js (`https://js.stripe.com/v3/`) at runtime, mounts a Payment Element using the `clientSecret`, and on submit calls `stripe.confirmPayment({ redirect: 'if_required' })` — for most cards this completes without ever leaving the page; redirect-requiring methods (e.g. 3D Secure) still bounce out and back via `return_url`.
4. **Our own** `customer.subscription.updated` webhook event (fired when the subscription moves from `incomplete` to `active`) persists the record to VBase — the webhook handler reads `name`/`email`/`company`/`phone`/`plan` from the **Subscription's own metadata** (set at creation).
5. The page polls `/_v/mdm-seller/subscription/status` to show the current status badge (Active / Past due / Canceled / none) and renewal date.

The redirect-to-Stripe-Checkout flow (`createSubscriptionCheckout`) still exists server-side but isn't called by any page right now.

## Real checkout flow (Subscription page)

This is the one that matters for actual seller subscriptions. Same embedded-Payment-Element mechanism as Embed Demo, but priced from MDM's real plans and reported into MDM as the system of record — see [Subscription (MDM-backed)](#subscription-mdm-backed) for the architecture reasoning.

1. Seller clicks **Subscribe** on a plan card. The browser sends only `{ planId, billingCycleId }` to `POST /_v/mdm-seller/subscription/mdm-checkout` — no email, no name, no amount.
2. The backend re-fetches MDM's plans itself and looks up the exact billing cycle by id — the price is **never** taken from the client. Identity comes from the logged-in VTEX admin user's own token (`getVtexAdminUser.ts` — the token's `sub` claim *is* the email; there's no separate `email` claim, confirmed against a real token), never typed in ad hoc.
3. Creates (or reuses) a Stripe Customer, with `name` set from `deriveDisplayName(email)` — a readable name derived from the email's local part (e.g. `adnan.shahzad` → `Adnan Shahzad`), since the VTEX admin token carries no separate first/last name. Without this, MDM showed the raw `external_reference_id` as "First Name" in its Customers list.
4. Creates the Stripe Subscription directly via the Subscriptions API — same `default_incomplete` + `expand: ['latest_invoice.payment_intent']` pattern as Embed Demo — using MDM's actual `interval`/`interval_count` (Stripe supports `day`/`week`/`month`/`year`, not just month/year; a "every 4 days" MDM plan was silently billed monthly by an earlier version of this code that only checked for `'year'` and defaulted everything else to `'month'` — fixed).
5. **Synchronously, in the same request**, reports the new subscription to MDM (`POST /subscriptions/events`) with `plan_id`, `billing_cycle_id`, `status`, `external_subscription_id`, `external_customer_id`, `current_period_start`/`current_period_end` (always included — see the note below), and a `customer` block with the required metadata keys.
6. Returns `{ clientSecret, publishableKey, subscriptionId }`. The browser mounts the Payment Element and confirms payment the same way as Embed Demo.
7. **No webhook of ours is in this loop at all.** From here, MDM's own separate Stripe webhook (registered directly in the Stripe Dashboard, pointing at MDM's own URL) picks up `customer.subscription.updated`/`.deleted` and `invoice.paid`/`.payment_failed` and updates the record MDM already has — see [Configuring the webhooks](#configuring-the-webhooks).

**Why no webhook of ours is needed here:** per MDM's guide, creating a *new* subscription record requires `plan_id`, which only we know at creation time — MDM's webhook can only *update* a record that already exists. So the point where a webhook would normally be needed (learning that a subscription was created) is instead handled synchronously, in the same request that creates it. Everything after that (renewals, cancellations, payment failures) genuinely is MDM's problem alone, via their own direct Stripe webhook.

**Required MDM metadata**, stamped on the Stripe Subscription/Customer at creation (exact key names, per MDM's guide) so their webhook can attribute events later:

```
source: "vtex"
external_reference_id: <the VTEX account, e.g. "adnnor332">
customer_group_type: "seller"
```
Plus two extra keys of our own (`mdm_plan_id`, `mdm_billing_cycle_id`) — not part of MDM's contract, kept for our own reference.

**Seller-profile sync (independent of checkout):** `getMySubscription` — i.e., every time the Subscription page loads — also fires a lightweight `POST /subscriptions/events` with *only* a `customer` block (`external_reference_id`, `customer_group_type: "seller"`, `email`, `display_name`). Per MDM's guide this is how a seller gets into MDM in the first place, independent of ever buying a plan. Idempotent on `(source, external_reference_id)`, so calling it on every page load is intentional — simpler than tracking whether it already ran. Best-effort: a sync failure never blocks the page.

### Configuring the webhooks

**Two separate destinations, two separate secrets** — this tripped us up once already (see the `mdmSellerToken` note above for the related token confusion). Registering a new one for MDM does not touch ours, and vice versa.

1. **Ours** (Embed Demo's status badge only) — Stripe Dashboard → add an endpoint:
   ```
   https://{account}.myvtex.com/_v/mdm-seller/subscription/webhook
   ```
   Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret into `stripeWebhookSecret` (see [Dev Settings guide](user-guide/dev-settings.md)).
2. **MDM's own** (real subscriptions, renewals) — a *different* Stripe Dashboard endpoint, pointing directly at MDM (e.g. `https://tradeasia.exchange/api/v1/subscriptions/stripe-webhook`), with events `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`. MDM holds that signing secret, not us — nothing to save on our side for this one.

## Subscription (MDM-backed)

Per MDM's own integration guide (`docs/vtex-subscriptions-integration-guide.html` in the MDM repo): **MDM never talks to Stripe directly** — VTEX's billing engine owns checkout, MDM is the system of record VTEX reports into and reads back from. The **Subscription** page (`/admin/mdm-seller/subscription`) implements that end to end now — see [Real checkout flow](#real-checkout-flow-subscription-page) above for the mechanics.

**Current scope:**

1. `GET /_v/mdm-seller/mdm-subscription` → MDM's `GET /subscriptions?source=vtex&external_reference_id=...`. If found, the page shows the plan name, billing cycle, status, and renewal/cancellation date, **plus** invoice history via `GET /_v/mdm-seller/mdm-invoices` (with date/amount filters, full-width table).
2. If MDM has no subscription for this seller, the page shows MDM's plans (`GET /_v/mdm-seller/mdm-plans`) with a working **Subscribe** button.
3. No manual name/email/company/phone form anywhere in this flow — identity comes from the VTEX admin token, and the seller's profile is pushed into MDM proactively (see above), not typed in ad hoc.

**Still out of scope:** canceling or changing plans from this page, and any VTEX Admin-side (marketplace-admin, cross-seller) Subscriptions/Billing screens — seller side only, for now.

**Open questions, updated:**

- **`external_reference_id`** — MDM's guide calls this "the VTEX Seller ID" without defining it precisely. This app sends `ctx.vtex.account` (the VTEX account name), and it demonstrably works end to end (checkout → MDM record creation → correct lookup on the next page load) — but it's still not formally confirmed with the MDM team as the *intended* long-term value versus a marketplace-specific seller id.
- **Auth — resolved, root cause was ours.** Two compounding bugs, both fixed: (1) `@vtex/api`'s HTTP client caches GET responses by URL only, so an early failing response got served back regardless of which token was sent later (fixed with `cacheable: CacheType.None` on the three Subscriptions GET calls); (2) a since-removed `mdmSellerToken` setting was being preferred over fresh `mdmUsername`/`mdmPassword` auth and wasn't valid for the Subscriptions module specifically. Confirmed live via a manual curl cross-check independent of this app's own HTTP client.
- **Response envelope — confirmed.** Same envelope as the rest of the MDM API: `{ success, statusCode, message, data: [...], errors }` for `GET /subscriptions/plans`; the client methods' defensive handling of a bare array is now just a harmless fallback.

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
