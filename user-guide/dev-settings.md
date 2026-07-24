# Dev Settings (Managing App Configuration)

This app's real Settings screen (**VTEX Admin → Apps → this app → Settings**) can still be *read* (`ctx.clients.apps.getAppSettings`), but `@vtex/api`'s Apps client exposes no way to *write* it — confirmed by reading the library's own source, not just an assumption. That's a permanent platform limitation, not a temporary gap waiting on some other feature, so — same as the marketplace app's own settings handler — actual configuration permanently lives in **VBase** via this endpoint, and every handler that needs settings (`readMdmConfig()`) falls back to it automatically when the real settings are empty. It's also where the marketplace app's [global settings](#auto-fetch-from-the-marketplace-app) get cached once fetched, so this endpoint stays load-bearing in production, not just a dev convenience.

> The endpoint is gated by a secret hardcoded in source (`mdm-dev-2026`, in `node/handlers/devSettingsHandler.ts`). "Dev" describes how it's protected (a hardcoded shared secret rather than real VTEX auth), not that it's disposable — don't remove it.

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

### Minimum settings for a working test setup

```sh
curl -X POST "https://adnnor332.myvtex.com/_v/mdm-seller/dev/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "mdm-dev-2026",
    "mdmApiEndpoint": "https://tradeasia.exchange/api/v1",
    "mdmUsername": "your-mdm-username",
    "mdmPassword": "your-mdm-password",
    "stripeSecretKey": "sk_test_51TvPWaPUzmnXEkZgehV5gj3L41LP0Zx8Z8cvwrMC0ycupfTWka7TiSCWSXpXTFNWCJRAeED9pEBYPp86Qn5htIkG00jH71zeCQ",
    "stripePublishableKey": "pk_test_51TvPWaPUzmnXEkZgbyr4UlyWK2Chm5bieaRSYdZunCTXWzdmuRugwQ5Gk4biP2aCfEuFZ87koJDohaB6yYrWS1Y500j3Q8kPNc",
    "stripeWebhookSecret": "whsec_LEjgEEHTcOwpawINMaVLKxpmlKdsXp3h",
    "stripeMonthlyAmountUsd": "25",
    "stripeYearlyAmountUsd": "250"
  }'
```

> ⚠️ **These Stripe keys and webhook secret are Test-mode defaults for this project** — no real money moves through them, but they are still live credentials. Replace `stripeSecretKey`/`stripePublishableKey` with your own `sk_live_...`/`pk_live_...` pair before accepting real payments, and treat `mdmUsername`/`mdmPassword` (never shared here — always your own) the same way. You shouldn't normally need to run this per seller anymore — see [Settings scope: master, workspaces, and multiple sellers](#settings-scope-master-workspaces-and-multiple-sellers) below for the auto-fetch mechanism that populates new seller accounts automatically.
>
> `stripeWebhookSecret` above (`whsec_LEjgE...`) is **our own** webhook (Embed Demo's status badge only) pointed at `/_v/mdm-seller/subscription/webhook`. MDM's own separate webhook — `https://tradeasia.exchange/api/v1/subscriptions/stripe-webhook` — uses a different signing secret (`whsec_pbGABiqIfgC1K5apX1QLRL0WxoGUD60g`) that **MDM holds and configures on their own side**; it is not something you set here, listed only for reference. See [README § Configuring the webhooks](../README.md#configuring-the-webhooks).

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

## Settings scope: master, workspaces, and multiple sellers

These settings are saved in **VBase**, which scopes data to whichever VTEX account + workspace made the request. Two things follow from that:

- **Linked workspace vs. `master`.** Settings saved while linked (e.g. `https://devadnan--adnnor332.myvtex.com/...`) live only in that dev workspace's VBase — they do **not** carry over once the app is published and running on `master` (`https://adnnor332.myvtex.com/...`, no workspace prefix). If you configured settings only on a dev workspace and then publish, you need to POST them again against the `master`-style URL.
- **Multiple sellers.** Every seller runs this app on their *own* separate VTEX account (which is what lets `external_reference_id` — set to `ctx.vtex.account` — uniquely identify each seller to MDM), so settings are never automatically shared between accounts at the VBase level — each seller's account has its own independent VBase.

### Auto-fetch from the marketplace app

You no longer need to manually POST these settings to every seller account. `readMdmConfig()` (in `devSettingsHandler.ts`) now falls back, in order:

1. Real VTEX Settings for this seller's own account (if ever filled in)
2. This seller's own local VBase (whatever was POSTed here directly)
3. **The marketplace app's global settings** — `tradechem-vtex-chemtradeasia-mdm` is the single source of truth for values that are identical across every seller (MDM login, Stripe platform keys). The first time a seller account has nothing saved locally, this app calls that app's `GET /_v/chemtradeasia-mdm/global-settings` (a machine-only endpoint, gated by its own shared secret — see that app's [06 — App Settings § Sharing settings with the seller app](../../tradechem-vtex-chemtradeasia-mdm/user-guide/06-app-settings.md#sharing-settings-with-the-seller-app)) and **caches the result into this seller's own VBase**, so it's a one-time network hop per seller account, not a per-request one.

In practice this means: onboarding a new seller now needs **zero manual settings setup** as long as the marketplace app has its global config filled in — it self-populates on first use.

**Forcing a re-fetch** (e.g. after MDM/Stripe credentials were rotated centrally): clear this seller's cached copy so the next request re-pulls the current global values.

```sh
curl -X DELETE "https://adnnor332.myvtex.com/_v/mdm-seller/dev/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "mdm-dev-2026",
    "keys": ["mdmApiEndpoint", "mdmUsername", "mdmPassword", "stripeSecretKey", "stripePublishableKey", "stripeWebhookSecret"]
  }'
```

The manual per-seller POST (documented above) still works and still takes precedence — use it if a specific seller genuinely needs a different value than everyone else.

## Diagnostics

There's a browsable index of every diagnostic/data endpoint in this app — see [Logs & Diagnostics](logs-and-diagnostics.md).

---

[← Back to README](../README.md)
