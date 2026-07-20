# Subscription & Billing

Go to **Admin → MDM → Subscription**.

> There are two Subscription pages in the sidebar — **Subscription** and **Subscription (Embed)**. They're the same subscription, just two ways to pay: Subscription sends you to Stripe's own checkout page; Subscription (Embed) collects your card without leaving this site. Everything below applies to both — the only difference is described in [Paying without leaving the page](#paying-without-leaving-the-page-subscription-embed).

## Checking your status

At the top of the page, a status badge shows your current subscription state:

| Status | Meaning |
|---|---|
| **Active** | Your subscription is paid and current. |
| **Trialing** | You're in a trial period. |
| **Past due** | A recent payment failed — Stripe will retry automatically. |
| **Canceled** | Your subscription has ended. |
| **No subscription yet** | You haven't subscribed. |

If you have an active plan, you'll also see which plan (Monthly/Yearly) and its renewal date.

## Subscribing

Fill in the form below the status card:

| Field | Required? |
|---|---|
| Company name | Optional |
| Contact name | Required |
| Email | Required — used for your Stripe receipt and account |
| Phone | Optional |
| Plan | Monthly or Yearly — pricing is shown next to each option |

Click **Pay $X/mo** or **Pay $X/yr**. You'll be redirected to Stripe's secure checkout page to enter your card details — no payment information is ever entered on this site directly.

## After payment

- On success, you're returned to this page with a confirmation message. Status may take a few seconds to update — refresh the page if it still shows the old status.
- If you cancel out of the Stripe checkout page without paying, you're returned here with a "Checkout was canceled" notice and no charge is made.

## Paying without leaving the page (Subscription (Embed))

On **Subscription (Embed)**, the same form has a **Continue to payment** button instead of a Pay button. After clicking it:

1. A card entry box appears on the same page (Stripe's Payment Element) — you never leave this site.
2. Enter your card details there and click **Pay $X/mo** (or **/yr**).
3. Most cards complete immediately, showing "Payment submitted" without any redirect. Some cards require an extra bank verification step (3D Secure) — if so, you'll briefly leave the page for that step and come straight back automatically.

Use **← Back** to change your plan or details before paying. Card details are always entered directly into Stripe's embedded form, never seen by this site — the "embed" only refers to where the form appears, not who processes the payment.

## Changing plans

If you already have an active subscription, the form's title changes to **Change plan** — select the other plan and pay to switch. Managing an existing subscription (updating your card, canceling, viewing invoices) is done through the Stripe customer portal / receipt email, not on this page.

## Troubleshooting

- **"Stripe is not configured for this seller yet."** — Payments haven't been enabled for your account yet. Contact the marketplace administrator.
- **Status stuck on "No subscription yet" after paying** — this page shows the last status Stripe confirmed. It's usually a few seconds behind; reload the page. If it's still wrong after a few minutes, contact support with your payment confirmation email.
- **On Subscription (Embed): the card entry box never appears after "Continue to payment"** — this loads Stripe's own script into the page; if your browser or network blocks it, try the regular **Subscription** page instead, which doesn't need it.
