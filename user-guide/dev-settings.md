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
| `stripeSecretKey` | Stripe secret key (`sk_test_...` / `sk_live_...`) |
| `stripePublishableKey` | Stripe publishable key (`pk_test_...` / `pk_live_...`) |
| `stripeWebhookSecret` | Signing secret (`whsec_...`) for **our own** webhook only — see [README § Stripe webhooks](../README.md#configuring-the-webhooks) for why there are two separate webhooks now |
| `stripeMonthlyAmountUsd` / `stripeYearlyAmountUsd` | Plan prices in USD, **Embed Demo page only** — default to `25` / `250` if unset. The real Subscription page prices plans from MDM directly and ignores these. |

You're not limited to these — any field you POST gets saved and is readable by any handler that calls `readMdmConfig()`.

> **Removed:** there used to be an `mdmSellerToken` setting (a pre-issued token, meant to be preferred over `mdmUsername`/`mdmPassword`). It was dropped — every MDM API call is already scoped by an explicit `vtex_seller_id`/`external_reference_id` parameter, so a separate token added no real isolation, and a stale saved one caused a real bug (the Subscription page failing with "Unauthenticated" against the Subscriptions module specifically, while the same account worked fine elsewhere). If you still have one saved from before, delete it — see **Remove** below.

### Which settings are required for which feature

| Feature | Required settings |
|---|---|
| Documents page | `mdmApiEndpoint` (or the default), `mdmUsername`, `mdmPassword` |
| Subscription page — viewing status/plans | `mdmUsername`, `mdmPassword` |
| Subscription page — **Subscribe** (real checkout) | `mdmUsername`, `mdmPassword`, `stripeSecretKey`, `stripePublishableKey` |
| Embed Demo page | `stripeSecretKey`, `stripePublishableKey` — `stripeWebhookSecret` needed for its status badge to update after payment |
| Catalog capture (broadcaster → MDM) | `mdmUsername`, `mdmPassword` |

Nothing here needs `stripeWebhookSecret` to *complete* a payment — Stripe confirms that directly to the browser. It's only needed for status to update automatically afterward (Embed Demo's own VBase status) or, for real MDM-backed subscriptions, for MDM's *own separate* webhook to track renewals — see the README section linked above.

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
- **`stripeSecretKey`** / **`stripePublishableKey`** — Stripe Dashboard → Developers → API keys (use `sk_test_...`/`pk_test_...` while testing, switch to the `_live_` pair only when ready to take real payments).
- **`stripeWebhookSecret`** — **this is our own webhook only**, not MDM's. Stripe Dashboard → Developers → Webhooks → **Add endpoint**, pointing at:
  ```
  https://{workspace}--{account}.myvtex.com/_v/mdm-seller/subscription/webhook
  ```
  Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Stripe shows a "Signing secret" once the endpoint is created — that's this value. **Separately**, MDM registers its own webhook destination (a different URL, a different secret they hold, not stored here) pointing directly at their own API — see [README § Stripe webhooks](../README.md#configuring-the-webhooks) for why both exist.

⚠️ Don't leave example/placeholder text (like `whsec_YOUR_SECRET_HERE`) saved in `stripeWebhookSecret` — run the **List** command above and check the masked tail doesn't end in obvious placeholder text. A fake value there fails signature verification the moment a real webhook call comes in, which is a confusing thing to debug after the fact.

### Testing in Stripe Test mode

If `stripeSecretKey`/`stripePublishableKey` are `sk_test_...`/`pk_test_...` (sandbox keys), no real card or money is involved. Use one of [Stripe's test cards](https://docs.stripe.com/testing) on any Subscription/Embed Demo page — the simplest is `4242 4242 4242 4242`, any future expiry date, any 3-digit CVC, any postal code.

---

## Diagnostics

There's a browsable index of every diagnostic/data endpoint in this app — see [Logs & Diagnostics](logs-and-diagnostics.md).

---

[← Back to README](../README.md)
