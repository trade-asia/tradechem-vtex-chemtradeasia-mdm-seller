import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Spinner, Alert, Modal, Button } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'
const STRIPE_JS_SRC = 'https://js.stripe.com/v3/'

const STATUS_LABELS = {
  active: { label: 'Active', color: '#059669', bg: '#ecfdf5', border: '#86efac' },
  trialing: { label: 'Trialing', color: '#2563eb', bg: '#eff6ff', border: '#93c5fd' },
  past_due: { label: 'Past due', color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
  canceled: { label: 'Canceled', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
}

const INVOICE_STATUS_COLORS = {
  paid: { color: '#059669', bg: '#ecfdf5' },
  pending: { color: '#b45309', bg: '#fffbeb' },
  failed: { color: '#dc2626', bg: '#fef2f2' },
}

const INVOICE_COLS = '1.5fr 1fr 140px 120px 140px'

const inputStyle = {
  border: '1px solid #d0d5dd',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12.5,
  color: '#333',
  fontFamily: 'inherit',
}

// MDM's *_formatted price strings always carry 2 decimals (e.g. "$208.35").
// Displayed amounts should be rounded (whole dollars) — strip the trailing
// decimal portion rather than reformatting from the raw number, so we keep
// MDM's currency symbol/locale formatting intact.
const roundFormattedAmount = (formatted) =>
  formatted ? formatted.replace(/([.,]\d{1,2})(?=\D*$)/, '') : formatted

const parseResponse = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    return { success: false, error: `Server error (HTTP ${res.status})` }
  }
}

const loadStripeJs = () => new Promise((resolve, reject) => {
  if (window.Stripe) { resolve(window.Stripe); return }
  const existing = document.querySelector(`script[src="${STRIPE_JS_SRC}"]`)
  if (existing) {
    existing.addEventListener('load', () => resolve(window.Stripe))
    existing.addEventListener('error', () => reject(new Error('Failed to load Stripe.js')))
    return
  }
  const script = document.createElement('script')
  script.src = STRIPE_JS_SRC
  script.async = true
  script.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error('Stripe.js loaded but window.Stripe is missing')))
  script.onerror = () => reject(new Error('Failed to load Stripe.js — it may be blocked by the admin panel\'s content security policy.'))
  document.head.appendChild(script)
})

// ── Current subscription card — read straight from MDM, not Stripe/VBase ──
const CurrentSubscriptionCard = ({ subscription }) => {
  const meta = STATUS_LABELS[subscription.status] ?? { label: subscription.status, color: '#6b7c93', bg: '#f7f9fa', border: '#e3e4e6' }
  const canceled = !!subscription.canceled_at

  return (
    <div style={{
      border: '1px solid #e0e4e8',
      borderRadius: 8,
      padding: '20px 24px',
      maxWidth: 560,
      marginBottom: 28,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: '#142032' }}>{subscription.plan}</div>
        <span style={{
          display: 'inline-block',
          background: meta.bg,
          border: `1px solid ${meta.border}`,
          borderRadius: 20,
          padding: '3px 12px',
          fontSize: 11,
          fontWeight: 700,
          color: meta.color,
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
        }}>
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 14 }}>{subscription.billing_cycle}</div>
      <div style={{ fontSize: 12, color: canceled ? '#dc2626' : '#666' }}>
        {canceled
          ? `Canceled ${subscription.canceled_at}`
          : subscription.current_period_end_formatted
            ? `Renews ${subscription.current_period_end_formatted}`
            : null}
      </div>
    </div>
  )
}

// ── Invoice history table (full width, with date/amount filters) ──
const InvoicesTable = ({ invoices }) => {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')

  const filtered = useMemo(() => {
    return invoices.filter(inv => {
      const chargedAt = inv.charged_at ? inv.charged_at.slice(0, 10) : null
      if (dateFrom && (!chargedAt || chargedAt < dateFrom)) return false
      if (dateTo && (!chargedAt || chargedAt > dateTo)) return false

      const amount = Number(inv.amount)
      if (amountMin && !(amount >= Number(amountMin))) return false
      if (amountMax && !(amount <= Number(amountMax))) return false

      return true
    })
  }, [invoices, dateFrom, dateTo, amountMin, amountMax])

  const hasFilters = dateFrom || dateTo || amountMin || amountMax

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#142032', marginBottom: 12 }}>Invoices</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>From</div>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>To</div>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Min amount</div>
          <input type="number" placeholder="0" min="0" value={amountMin} onChange={e => setAmountMin(e.target.value)} style={{ ...inputStyle, width: 90 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Max amount</div>
          <input type="number" placeholder="Any" min="0" value={amountMax} onChange={e => setAmountMax(e.target.value)} style={{ ...inputStyle, width: 90 }} />
        </div>
        {hasFilters && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setAmountMin(''); setAmountMax('') }}
            style={{
              border: '1px solid #d0d5dd',
              background: '#fff',
              color: '#555',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#999', fontSize: 13, border: '1px solid #e0e4e8', borderRadius: 6 }}>
          {invoices.length === 0 ? 'No invoices yet.' : 'No invoices match your filters.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: INVOICE_COLS,
            gap: '0 14px',
            padding: '10px 16px',
            background: '#f0f4f8',
            borderBottom: '2px solid #dce4ec',
            fontSize: 11,
            fontWeight: 700,
            color: '#6b7c93',
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
          }}>
            <div>Invoice</div>
            <div />
            <div>Date</div>
            <div>Status</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
          </div>
          {filtered.map((inv, idx) => {
            const statusMeta = INVOICE_STATUS_COLORS[inv.status] ?? { color: '#6b7c93', bg: '#f7f9fa' }
            return (
              <div key={inv.id ?? idx} style={{
                display: 'grid',
                gridTemplateColumns: INVOICE_COLS,
                gap: '0 14px',
                padding: '12px 16px',
                borderBottom: '1px solid #eee',
                alignItems: 'center',
                background: idx % 2 === 0 ? '#fff' : '#fafcfe',
                fontSize: 12.5,
              }}>
                <div style={{ fontFamily: 'monospace', color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inv.external_invoice_id}
                </div>
                <div />
                <div style={{ color: '#666' }}>{inv.charged_at_formatted ?? inv.charged_at ?? '-'}</div>
                <div>
                  <span style={{
                    display: 'inline-block',
                    background: statusMeta.bg,
                    color: statusMeta.color,
                    borderRadius: 10,
                    padding: '2px 8px',
                    fontSize: 10.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                  }}>
                    {inv.status}
                  </span>
                </div>
                <div style={{ textAlign: 'right', fontWeight: 600, color: '#142032' }}>
                  {inv.amount_formatted ?? inv.amount}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Checkout modal: email/name -> Stripe Payment Element -> success ──
// The price is never sent from here — only planId/billingCycleId. The
// backend re-resolves the actual amount from MDM's plans response itself.
// No email/name form — identity comes from the logged-in VTEX admin user
// server-side (see getVtexAdminUser.ts), never typed in ad hoc. Opening the
// modal goes straight to initializing the Stripe subscription and mounting
// the Payment Element.
const CheckoutModal = ({ plan, cycle, onClose, onSubscribed }) => {
  const [phase, setPhase] = useState('loading') // 'loading' | 'payment' | 'success'
  const [initError, setInitError] = useState(null)
  const [payError, setPayError] = useState(null)
  const [paying, setPaying] = useState(false)

  const paymentContainerRef = useRef(null)
  const stripeRef = useRef(null)
  const elementsRef = useRef(null)
  const paymentElementRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        const res = await fetch(`${BASE}/subscription/mdm-checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: plan.id, billingCycleId: cycle.id }),
        })
        const data = await parseResponse(res)
        if (!data.success || !data.clientSecret || !data.publishableKey) {
          throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Failed to start checkout'))
        }

        const Stripe = await loadStripeJs()
        if (cancelled) return

        const stripe = Stripe(data.publishableKey)
        const elements = stripe.elements({ clientSecret: data.clientSecret })
        const paymentElement = elements.create('payment')

        stripeRef.current = stripe
        elementsRef.current = elements
        paymentElementRef.current = paymentElement

        setPhase('payment')
      } catch (err) {
        if (!cancelled) setInitError(err.message)
      }
    }

    init()
    return () => { cancelled = true }
  }, [plan.id, cycle.id])

  useEffect(() => {
    if (phase !== 'payment' || !paymentElementRef.current || !paymentContainerRef.current) return
    paymentElementRef.current.mount(paymentContainerRef.current)
    return () => {
      try { paymentElementRef.current && paymentElementRef.current.unmount() } catch {}
    }
  }, [phase])

  const handleConfirmPayment = async () => {
    if (!stripeRef.current || !elementsRef.current) return
    setPayError(null)
    setPaying(true)
    try {
      const { error } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: `${window.location.origin}${window.location.pathname}` },
        redirect: 'if_required',
      })
      if (error) {
        setPayError(error.message ?? 'Payment failed.')
        setPaying(false)
        return
      }
      setPhase('success')
    } catch (err) {
      setPayError(err.message)
    } finally {
      setPaying(false)
    }
  }

  return (
    <Modal isOpen centered onClose={onClose} title={phase === 'success' ? 'Subscribed' : `Subscribe — ${plan.name}`}>
      <div style={{ width: '100%' }}>
        {phase === 'success' ? (
          <>
            <div style={{ fontSize: 13, color: '#333', marginBottom: 18 }}>
              Payment submitted for the <strong>{plan.name}</strong> plan ({cycle.label}). It may take a few seconds to show up above.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variation="primary" onClick={onSubscribed}>Done</Button>
            </div>
          </>
        ) : phase === 'payment' ? (
          <>
            <div style={{
              background: '#f7f9fa',
              border: '1px solid #e3e4e6',
              borderRadius: 6,
              padding: '8px 12px',
              marginBottom: 16,
              fontSize: 12,
              color: '#333',
            }}>
              <strong>{plan.name}</strong> — {cycle.label}
            </div>

            <div ref={paymentContainerRef} style={{ marginBottom: 18, minHeight: 200 }} />

            {payError && <div style={{ marginBottom: 14 }}><Alert type="error">{payError}</Alert></div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variation="tertiary" onClick={onClose} disabled={paying}>Cancel</Button>
              <Button variation="primary" onClick={handleConfirmPayment} isLoading={paying}>
                Pay
              </Button>
            </div>
          </>
        ) : initError ? (
          <>
            <div style={{ marginBottom: 16 }}><Alert type="error">{initError}</Alert></div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variation="tertiary" onClick={onClose}>Close</Button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
        )}
      </div>
    </Modal>
  )
}

// ── One plan card in the "no subscription yet" plan-selection view ──
// Flex column with the action button pinned to the bottom (marginTop: auto)
// so buttons line up across cards regardless of feature-list length.
const PlanCard = ({ plan, interval, onSelect }) => {
  const cycle = (plan.billing_cycles ?? []).find(c => c.interval === interval)
  if (plan.pricing_mode !== 'contact' && !cycle) return null

  return (
    <div style={{
      border: plan.recommended ? '2px solid #7c3aed' : '1px solid #e0e4e8',
      borderRadius: 10,
      padding: '22px 22px 20px',
      position: 'relative',
      background: '#fff',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {plan.recommended && (
        <div style={{
          position: 'absolute',
          top: -11,
          left: 20,
          background: '#7c3aed',
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.4px',
          textTransform: 'uppercase',
          borderRadius: 12,
          padding: '3px 10px',
        }}>
          Best value
        </div>
      )}

      <div style={{ fontWeight: 700, fontSize: 16, color: '#142032', marginBottom: 4 }}>{plan.name}</div>
      {plan.description && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 14 }}>{plan.description}</div>
      )}

      {plan.pricing_mode !== 'contact' && (() => {
        const hasDiscount = Number(cycle.discount_percent) > 0
        return (
          <div style={{
            border: '1px solid #e0e4e8',
            borderRadius: 6,
            padding: '10px 14px',
            margin: '14px 0 18px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>{cycle.label}</span>
            <div style={{ textAlign: 'right' }}>
              <div>
                {hasDiscount && (
                  <span style={{ fontSize: 12, color: '#999', textDecoration: 'line-through', marginRight: 6 }}>
                    {roundFormattedAmount(cycle.price_formatted)}
                  </span>
                )}
                <span style={{ fontSize: 16, fontWeight: 800, color: '#142032' }}>
                  {roundFormattedAmount(cycle.effective_price_formatted ?? cycle.price_formatted)}
                </span>
              </div>
              {hasDiscount && (
                <div style={{ fontSize: 11, color: '#059669', fontWeight: 700 }}>
                  -{cycle.discount_percent}%
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {plan.features?.length > 0 && (
        <ul style={{ margin: '0 0 18px', padding: 0, listStyle: 'none' }}>
          {plan.features.map((f, i) => (
            <li key={i} style={{ fontSize: 12.5, color: '#444', padding: '4px 0', display: 'flex', gap: 6 }}>
              <span style={{ color: '#059669' }}>✓</span> {f}
            </li>
          ))}
        </ul>
      )}

      {plan.pricing_mode === 'contact' ? (
        <a
          href={plan.cta_url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginTop: 'auto',
            display: 'block',
            textAlign: 'center',
            background: '#142032',
            color: '#fff',
            borderRadius: 6,
            padding: '9px 0',
            fontSize: 13,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          {plan.cta_label ?? 'Contact Sales'}
        </a>
      ) : (
        <button
          onClick={() => onSelect(plan, cycle)}
          style={{
            marginTop: 'auto',
            width: '100%',
            border: 'none',
            background: '#142032',
            color: '#fff',
            borderRadius: 6,
            padding: '9px 0',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Subscribe
        </button>
      )}
    </div>
  )
}

const INTERVAL_LABELS = { month: 'Monthly', year: 'Yearly' }

const PlanSelection = ({ plans, onSelect }) => {
  const intervals = useMemo(() => {
    const set = new Set()
    plans.forEach(p => (p.billing_cycles ?? []).forEach(c => set.add(c.interval)))
    return Array.from(set)
  }, [plans])

  const [interval, setInterval_] = useState(intervals.includes('month') ? 'month' : intervals[0])

  return (
    <>
      {intervals.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <div style={{
            display: 'inline-flex',
            background: '#f0f2f5',
            border: '1px solid #e0e4e8',
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}>
            {intervals.map(i => (
              <button
                key={i}
                onClick={() => setInterval_(i)}
                style={{
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 24px',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: interval === i ? '#7c3aed' : 'transparent',
                  color: interval === i ? '#fff' : '#555',
                }}
              >
                {INTERVAL_LABELS[i] ?? i}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 20,
        alignItems: 'stretch',
      }}>
        {plans.map(plan => <PlanCard key={plan.id} plan={plan} interval={interval} onSelect={onSelect} />)}
      </div>
    </>
  )
}

// ── Page ──
// Landing page for subscriptions: checks MDM (the system of record) for an
// existing subscription. If found, shows it plus invoice history. If not,
// shows MDM's available plans — selection isn't wired to checkout yet.
const SellerSubscription = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [subscription, setSubscription] = useState(null)
  const [invoices, setInvoices] = useState([])
  const [plans, setPlans] = useState(null)
  const [checkout, setCheckout] = useState(null) // { plan, cycle } | null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const subRes = await fetch(`${BASE}/mdm-subscription`)
      const subData = await parseResponse(subRes)
      if (!subData.success) throw new Error(subData.detail ? `${subData.error}: ${subData.detail}` : subData.error)

      if (subData.subscription) {
        setSubscription(subData.subscription)
        setPlans(null)

        const invRes = await fetch(`${BASE}/mdm-invoices`)
        const invData = await parseResponse(invRes)
        setInvoices(invData.success ? (invData.invoices ?? []) : [])
      } else {
        setSubscription(null)
        setInvoices([])
        const plansRes = await fetch(`${BASE}/mdm-plans`)
        const plansData = await parseResponse(plansRes)
        if (!plansData.success) throw new Error(plansData.detail ? `${plansData.error}: ${plansData.detail}` : plansData.error)
        setPlans(plansData.plans ?? [])
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="pa6">
      <div style={{ fontSize: 28, fontWeight: 700, color: '#142032', marginBottom: 24 }}>
        Subscription
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert type="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
      ) : subscription ? (
        <>
          <CurrentSubscriptionCard subscription={subscription} />
          <InvoicesTable invoices={invoices} />
        </>
      ) : plans ? (
        plans.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#999', fontSize: 13 }}>
            No plans are available right now.
          </div>
        ) : (
          <PlanSelection plans={plans} onSelect={(plan, cycle) => setCheckout({ plan, cycle })} />
        )
      ) : null}

      {checkout && (
        <CheckoutModal
          plan={checkout.plan}
          cycle={checkout.cycle}
          onClose={() => setCheckout(null)}
          onSubscribed={() => { setCheckout(null); load() }}
        />
      )}
    </div>
  )
}

export default SellerSubscription
