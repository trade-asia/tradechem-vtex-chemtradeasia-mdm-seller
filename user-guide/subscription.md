# Subscription

Go to **Admin → MDM → Subscription**.

This page shows what's on file for your account, checked live — not something stored on this site.

## If you already have a subscription

You'll see a card with your plan name, a status badge, and either a renewal date or a cancellation date, followed by your invoice history (invoice reference, date, status, amount) — with From/To date and Min/Max amount filters above the table.

| Status | Meaning |
|---|---|
| **Active** | Your subscription is paid and current. |
| **Trialing** | You're in a trial period. |
| **Past due** | A recent payment failed. |
| **Canceled** | Your subscription has ended. |

This is currently **read-only** — there's no cancel or change-plan button on this page yet.

## If you don't have a subscription yet

The page shows the available plans instead — name, description, feature list, and price (with a Monthly/Yearly toggle above the grid if a plan offers both, and a discount badge if a longer cycle is cheaper). The plan you'd get the best deal on is marked **Best value**.

### Subscribing

Click **Subscribe** on any priced plan. There's no form to fill in — your email is already known from your VTEX admin login, so it goes straight to a card entry box (Stripe's Payment Element) right there in the same window. Enter your card details and click **Pay**.

- Most cards complete immediately — you'll see a confirmation and the page will show your new subscription within a few seconds.
- Some cards require an extra bank verification step (3D Secure); if so you'll briefly leave the page for that step and land back automatically.

Card details go directly to Stripe — this site never sees or stores them.

Plans marked **Contact Sales** (no self-checkout) show a Contact Sales link instead of a Subscribe button.

## Troubleshooting

- **"Failed to load subscription from MDM" / "Failed to load plans from MDM"** — this page depends on a backend integration. Contact the marketplace administrator; this isn't something you can fix from here.
- **"Could not determine your account email."** — the page couldn't identify who you are from your VTEX admin login. Try logging out and back in; if it persists, contact the marketplace administrator.
- **The card entry box never appears after clicking Subscribe** — this loads Stripe's own script into the page; if your browser or network blocks it, that's likely why. Try a different browser or disabling ad-blocking extensions for this page.
- **I paid but my plan still shows as unavailable** — reload the page after a few seconds; confirmation can take a moment to register.
