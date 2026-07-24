# Subscription

Go to **Admin → MDM → Subscription**.

This page shows what's on file for your account, checked live — not something stored on this site.

## If you already have a subscription

You'll see a card with your plan name, a status badge, and one of three date lines depending on where the subscription stands, followed by your invoice history (invoice reference, date, status, amount) — with From/To date and Min/Max amount filters above the table.

| Status | Meaning |
|---|---|
| **Active** | Your subscription is paid and current. |
| **Trialing** | You're in a trial period. |
| **Past due** | A recent payment failed. |
| **Canceled** | Your subscription has ended. |

| Date line shown | Meaning |
|---|---|
| **Renews {date}** | Normal active subscription — will bill again on this date. |
| **Cancels {date}** | You've scheduled a cancellation (see below) — still active and billed as normal until this date, then it ends. |
| **Canceled {date}** | Already ended. |

### Canceling

Click **Cancel subscription** on an active card, then **Confirm**. This schedules cancellation for the **end of your current paid period** — it does not cancel immediately, and you keep full access until then. The card updates right away to show **Cancels {date}**; the Cancel button is hidden once a cancellation is scheduled, since it's already in effect and clicking again does nothing new.

The status badge itself doesn't change to **Canceled** at this point — that only happens once the period actually ends, which is handled on MDM's side independently of this page. If you change your mind, contact the marketplace administrator before the scheduled date; there's no self-service "undo" button on this page yet.

There's still no change-plan button on this page — switching plans requires contacting the marketplace administrator.

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
- **"Failed to cancel subscription"** — the detail message underneath usually explains why (e.g. no active subscription to cancel, or a Stripe-side error). If it's not self-explanatory, contact the marketplace administrator.
- **I clicked Cancel but the status still says Active** — that's expected; canceling schedules the end of the current period rather than acting immediately. Look for the **Cancels {date}** line under the plan name to confirm it registered.
