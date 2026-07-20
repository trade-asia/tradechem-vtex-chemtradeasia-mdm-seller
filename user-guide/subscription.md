# Subscription & Billing

Go to **Admin → MDM → Subscription**.

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

## Changing plans

If you already have an active subscription, the form's title changes to **Change plan** — select the other plan and pay to switch. Managing an existing subscription (updating your card, canceling, viewing invoices) is done through the Stripe customer portal / receipt email, not on this page.

## Troubleshooting

- **"Stripe is not configured for this seller yet."** — Payments haven't been enabled for your account yet. Contact the marketplace administrator.
- **Status stuck on "No subscription yet" after paying** — this page shows the last status Stripe confirmed. It's usually a few seconds behind; reload the page. If it's still wrong after a few minutes, contact support with your payment confirmation email.
