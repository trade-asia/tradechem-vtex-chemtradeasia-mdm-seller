# chemtradeasia-mdm-seller

VTEX IO app (`tradeasiab2b.chemtradeasia-mdm-seller`) providing seller-facing MDM tools inside the seller's own VTEX admin:

- **Documents** — upload/manage a seller's own SDS / TDS / MSDS PDFs against their MDM-linked products.
- **Subscription** — seller marketplace subscription (Monthly/Yearly) via Stripe Checkout.
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
| `/admin/mdm-seller/subscription` | `SellerSubscription` | Subscribe / view subscription status, Stripe-backed |

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

### Subscription (Stripe)

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `POST` | `/_v/mdm-seller/subscription/checkout` | `createSubscriptionCheckout` (`subscriptionHandler.ts`) | Creates a Stripe Checkout Session, `mode: subscription`. Body: `{ plan: "monthly"\|"yearly", name, email, company?, phone? }`. Returns `{ success, url }` — redirect the browser to `url`. **Price is always resolved server-side from settings; the client only controls `plan`.** |
| `POST` | `/_v/mdm-seller/subscription/webhook` | `stripeWebhookHandler` | Public Stripe webhook. Verifies `stripe-signature` against `stripeWebhookSecret`, then persists status to VBase on `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `GET` | `/_v/mdm-seller/subscription/status` | `getSubscriptionStatus` | Current subscription record + configured plan pricing, for the UI |

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
| `stripeSecretKey` | Stripe secret key (`sk_test_...` / `sk_live_...`) |
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
| `mdmq` | `p{productId}`, `index`, `event-log` | Catalog-capture queue: per-product capture state, an index of captured product ids, and a rolling event log (last 30) |

## Stripe subscription flow

1. Seller fills the form on `/admin/mdm-seller/subscription` (plan, name, email, company, phone) and clicks **Pay**.
2. Browser `POST`s to `/_v/mdm-seller/subscription/checkout`. The backend looks up `stripeMonthlyAmountUsd`/`stripeYearlyAmountUsd` from settings, creates a Stripe Checkout Session (`price_data` with `recurring.interval` set from the chosen plan), and returns the session `url`.
3. Browser redirects to Stripe's hosted checkout page.
4. On completion, Stripe redirects back to `/admin/mdm-seller/subscription?status=success|cancel` **and** asynchronously calls the webhook.
5. The webhook (`/_v/mdm-seller/subscription/webhook`) verifies the signature and writes the subscription record to VBase (`mdm-subscription`/`status`).
6. The Subscription page polls `/_v/mdm-seller/subscription/status` to show the current status badge (Active / Past due / Canceled / none) and renewal date.

### Configuring the webhook

In the Stripe Dashboard (or CLI), add an endpoint:

```
https://{account}.myvtex.com/_v/mdm-seller/subscription/webhook
```

Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the generated signing secret into `stripeWebhookSecret`.

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
