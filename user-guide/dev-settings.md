# Dev Settings (Managing App Configuration)

This app's real Settings screen (**VTEX Admin → Apps → this app → Settings**) is the intended way to configure it in production. But this seller edition currently has no Apps admin UI to reach that screen, and the app's own token can't write its own settings (`403`) — so until that's available, configuration lives in **VBase** via a dev-only endpoint, and every handler that needs settings (`readMdmConfig()`) falls back to it automatically when the real settings are empty.

> ⚠️ **Dev only.** The endpoint is gated by a secret hardcoded in source (`mdm-dev-2026`, in `node/handlers/devSettingsHandler.ts`). Remove this handler and its route (`devSettings` in `service.json`) once real Settings access is available, before publishing to production.

All requests go to:

```
https://{workspace}--{account}.myvtex.com/_v/mdm-seller/dev/settings
```

For a linked dev workspace this looks like `https://devadnan--adnnor332.myvtex.com/_v/mdm-seller/dev/settings` — check `vtex whoami` if unsure which workspace/account you're linked to.

## Settings this app uses

| Key | Purpose |
|---|---|
| `mdmApiEndpoint` | Base URL of the MDM API (defaults to `https://tradeasia.exchange/api/v1` if unset) |
| `mdmUsername` / `mdmPassword` | MDM login used to obtain a bearer token |
| `mdmSellerToken` | A pre-issued, seller-scoped MDM token — preferred over username/password if set |
| `stripeSecretKey` | Stripe secret key (`sk_test_...` / `sk_live_...`) |
| `stripeWebhookSecret` | Signing secret (`whsec_...`) for the subscription webhook |
| `stripeMonthlyAmountUsd` / `stripeYearlyAmountUsd` | Plan prices in USD — default to `25` / `250` if unset |

You're not limited to these — any field you POST gets saved and is readable by any handler that calls `readMdmConfig()`.

---

## List — see what's currently saved

```sh
curl "https://devadnan--adnnor332.myvtex.com/_v/mdm-seller/dev/settings?secret=mdm-dev-2026"
```

Returns every saved key. Values whose key name contains `password`, `secret`, or `token` are **masked** to their last few characters (e.g. `••••••••W... (set, 15 chars)`) so you can confirm the right value was saved without it being fully readable over the wire. Everything else (endpoints, usernames, amounts) is returned in full.

```json
{
  "success": true,
  "settings": {
    "mdmApiEndpoint": "https://tradeasia.exchange/api/v1",
    "mdmUsername": "you@example.com",
    "mdmPassword": "••••••••1234 (set, 9 chars)",
    "stripeSecretKey": "••••••••abcd (set, 32 chars)"
  }
}
```

---

## Add / Update — merges into what's already saved

```sh
curl -X POST "https://devadnan--adnnor332.myvtex.com/_v/mdm-seller/dev/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "mdm-dev-2026",
    "stripeSecretKey": "sk_test_...",
    "stripeWebhookSecret": "whsec_...",
    "stripeMonthlyAmountUsd": "25",
    "stripeYearlyAmountUsd": "250"
  }'
```

You only need to send the fields you're adding or changing — this **merges** into the existing saved config rather than replacing it, so anything you leave out is untouched. Response:

```json
{ "success": true, "updated": ["stripeSecretKey", "stripeWebhookSecret", ...], "allKeys": [...] }
```

`allKeys` is the full list of everything now saved, as a sanity check.

---

## Remove — deletes only the named fields

```sh
curl -X DELETE "https://devadnan--adnnor332.myvtex.com/_v/mdm-seller/dev/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "mdm-dev-2026",
    "keys": ["stripeSecretKey", "stripeWebhookSecret"]
  }'
```

Removes just the listed keys; everything else stays as-is. Response:

```json
{ "success": true, "removed": [...], "remainingKeys": [...] }
```

---

## Where the values come from

- **MDM credentials** (`mdmApiEndpoint`, `mdmUsername`, `mdmPassword`) — issued by whoever manages the ChemTradeAsia MDM system.
- **`stripeSecretKey`** — Stripe Dashboard → Developers → API keys → "Secret key" (use a `sk_test_...` key while testing, switch to `sk_live_...` only when ready to take real payments).
- **`stripeWebhookSecret`** — Stripe Dashboard → Developers → Webhooks → **Add endpoint**, pointing at:
  ```
  https://{workspace}--{account}.myvtex.com/_v/mdm-seller/subscription/webhook
  ```
  Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Stripe shows a "Signing secret" once the endpoint is created — that's this value.

There's no `stripePublishableKey` setting because this app doesn't need one — the Subscription page redirects to Stripe's own hosted Checkout page rather than embedding Stripe Elements, so only the secret key (server-side) is ever used.

---

[← Back to README](../README.md)
