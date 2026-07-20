import React, { useState, useEffect, useCallback } from 'react'
import { PageHeader, Spinner, Alert, Input, RadioGroup, Button } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'

const STATUS_LABELS = {
  active: { label: 'Active', color: '#059669', bg: '#ecfdf5', border: '#86efac' },
  trialing: { label: 'Trialing', color: '#2563eb', bg: '#eff6ff', border: '#93c5fd' },
  past_due: { label: 'Past due', color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
  unpaid: { label: 'Unpaid', color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
  incomplete: { label: 'Incomplete', color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
  canceled: { label: 'Canceled', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const parseResponse = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    return { success: false, error: `Server error (HTTP ${res.status})` }
  }
}

const formatDate = (iso) => {
  if (!iso) return null
  try { return new Date(iso).toLocaleDateString() } catch { return null }
}

const SellerSubscription = () => {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [subscription, setSubscription] = useState(null)
  const [pricing, setPricing] = useState({ monthlyUsd: 25, yearlyUsd: 250 })
  const [returnStatus, setReturnStatus] = useState(null)

  const [plan, setPlan] = useState('monthly')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [phone, setPhone] = useState('')
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${BASE}/subscription/status`)
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.error ?? 'Failed to load subscription status')
      setSubscription(data.subscription ?? null)
      if (data.pricing) setPricing(data.pricing)
      if (data.subscription) {
        if (data.subscription.name) setName(data.subscription.name)
        if (data.subscription.email) setEmail(data.subscription.email)
        if (data.subscription.company) setCompany(data.subscription.company)
        if (data.subscription.phone) setPhone(data.subscription.phone)
        if (data.subscription.plan) setPlan(data.subscription.plan)
      }
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get('status')
    if (status === 'success' || status === 'cancel') {
      setReturnStatus(status)
      params.delete('status')
      params.delete('session_id')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])

  const handleSubmit = async () => {
    setFormError(null)
    if (!name.trim()) { setFormError('Contact name is required.'); return }
    if (!email.trim() || !EMAIL_RE.test(email.trim())) { setFormError('A valid email is required.'); return }

    setSubmitting(true)
    try {
      const res = await fetch(`${BASE}/subscription/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          name: name.trim(),
          email: email.trim(),
          company: company.trim(),
          phone: phone.trim(),
        }),
      })
      const data = await parseResponse(res)
      if (!data.success || !data.url) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Failed to start checkout'))
      }
      window.location.href = data.url
    } catch (err) {
      setFormError(err.message)
      setSubmitting(false)
    }
  }

  const statusMeta = subscription?.status ? (STATUS_LABELS[subscription.status] ?? STATUS_LABELS.incomplete) : null
  const renewalDate = formatDate(subscription?.currentPeriodEnd)

  return (
    <div className="pa6">
      <PageHeader
        title="Subscription"
        subtitle="Manage your marketplace seller subscription plan and billing"
      />

      {returnStatus === 'success' && (
        <div style={{ marginBottom: 16 }}>
          <Alert type="success">
            Payment submitted. It may take a few seconds for your subscription status to update below.
          </Alert>
        </div>
      )}
      {returnStatus === 'cancel' && (
        <div style={{ marginBottom: 16 }}>
          <Alert type="warning">Checkout was canceled — no payment was made.</Alert>
        </div>
      )}
      {loadError && (
        <div style={{ marginBottom: 16 }}>
          <Alert type="error">{loadError}</Alert>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
      ) : (
        <>
          {/* ── Current status ── */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: statusMeta ? statusMeta.bg : '#f7f9fa',
            border: `1px solid ${statusMeta ? statusMeta.border : '#e3e4e6'}`,
            borderRadius: 8,
            padding: '14px 16px',
            marginBottom: 20,
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7c93', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                Current status
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: statusMeta ? statusMeta.color : '#142032', marginTop: 2 }}>
                {statusMeta ? statusMeta.label : 'No subscription yet'}
              </div>
              {subscription?.plan && (
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                  Plan: {subscription.plan === 'yearly' ? 'Yearly' : 'Monthly'}
                  {renewalDate && ` · Renews ${renewalDate}`}
                </div>
              )}
            </div>
          </div>

          {/* ── Checkout form ── */}
          <div style={{
            border: '1px solid #e0e4e8',
            borderRadius: 8,
            padding: '20px 24px',
            maxWidth: 560,
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#142032', marginBottom: 4 }}>
              {subscription?.status === 'active' ? 'Change plan' : 'Subscribe'}
            </div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 18 }}>
              You will be redirected to Stripe to complete payment securely.
            </div>

            <div style={{ marginBottom: 16 }}>
              <RadioGroup
                name="plan"
                hideBorder
                options={[
                  { value: 'monthly', label: `Monthly — $${pricing.monthlyUsd}/mo` },
                  { value: 'yearly', label: `Yearly — $${pricing.yearlyUsd}/yr` },
                ]}
                value={plan}
                onChange={(e) => setPlan(e.currentTarget.value)}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <Input label="Company name" placeholder="Your company" value={company} onChange={e => setCompany(e.target.value)} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <Input label="Contact name" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div style={{ marginBottom: 14 }}>
              <Input label="Email" type="email" placeholder="billing@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div style={{ marginBottom: 18 }}>
              <Input label="Phone (optional)" placeholder="+1 555 000 0000" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>

            {formError && <div style={{ marginBottom: 14 }}><Alert type="error">{formError}</Alert></div>}

            <Button variation="primary" onClick={handleSubmit} isLoading={submitting}>
              {plan === 'yearly' ? `Pay $${pricing.yearlyUsd}/yr` : `Pay $${pricing.monthlyUsd}/mo`}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export default SellerSubscription
