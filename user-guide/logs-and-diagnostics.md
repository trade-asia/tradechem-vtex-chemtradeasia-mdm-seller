# Logs & Diagnostics

A browsable index of every diagnostic and data endpoint in this app, so nobody has to remember URLs by heart.

```
https://{workspace}--{account}.myvtex.com/_v/mdm-seller/logs
```

Open it directly in a browser tab (needs to be a tab where you're logged into that account's admin — some of the linked pages, like `debug-admin-token` and manual `capture`, only work with a real admin session; opening them via `curl` will show "no session"). It's implemented in `node/handlers/logsHubHandler.ts` — a single self-contained HTML page, no build step, no auth beyond being logged into VTEX admin.

## What's on it

| Section | Covers |
|---|---|
| **Product Capture & MDM Sync** | `capture-events` (broadcaster events received + outcome), `my-products` (captured seller products + state), `debug-admin-token` (is an admin session present? expiry countdown), and a form to manually run `capture?productId=` |
| **Seller-Scoped MDM Data** | `products` (this seller's MDM product feed), `countries` |
| **Documents API** | Reference for the endpoints behind the Documents admin page |
| **Subscriptions** | `subscription/status`, `mdm-subscription`, `mdm-plans`, `mdm-invoices`, and reference links for the checkout/webhook POST routes |
| **Config (dev only)** | A quick form to view `dev/settings` (paste the dev secret, no need to hand-build the curl command — see [Dev Settings](dev-settings.md) for the full read/write/delete reference) |
| **Marketplace App** | Links out to `chemtradeasia-mdm`'s own logs hub and catalog-sync diagnostics (different app, different host — see that app's own docs) |
| **MDM Backend** | A link to MDM's own live server log viewer — first stop for any raw `"Server error."` response, since that means the failure happened on MDM's side, not ours |

## `debug-admin-token` specifically

Shows whether the current request carries a logged-in admin session, and if so, its expiry. This is the credential the manual `capture` action and MDM-derived-email checkout both depend on — if either is failing with an identity-related error, check this first. Never echoes the token itself, only its presence and decoded expiry/account/user claims.

```
GET /_v/mdm-seller/debug-admin-token
```

```json
{
  "adminUserToken": "present",
  "tokenLength": 604,
  "account": "adnnor332",
  "user": "adnan.shahzad@nestosh.com",
  "expiresAt": "2026-07-22T18:48:08.000Z",
  "remainingMinutes": 42,
  "expired": false
}
```

(`user` here is decoded from the token's `sub` claim — see the note in `node/helpers/getVtexAdminUser.ts` about why: there's no separate `email` claim, `sub` *is* the email.)

---

[← Back to README](../README.md)
