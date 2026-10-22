import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom'
import { Spinner, Alert, Input, Dropdown, Button, Modal, Tag, Pagination } from 'vtex.styleguide'
import ProductStatusModal from './ProductStatusModal'
import DocumentsModal from './DocumentsModal'
import PriceInventoryModal from './PriceInventoryModal'

const BASE = '/_v/mdm-seller'
const PER_PAGE = 20
// Hidden, not removed (2026-10-18, per explicit instruction) — redundant
// with the media/document upload MDM's own Edit/Add product screens
// already have. Flip back to true to restore the buttons; nothing else
// here was touched (modals, handlers, state all still fully wired).
const SHOW_MEDIA_DOCUMENTS_BUTTONS = false
const DEBOUNCE_MS = 500
const SAMPLE_CSV_URL = 'https://tradeasia.exchange/vtex-product-import-sample.csv'

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
  { value: 'pending', label: 'Pending Approval' },
  { value: 'rejected', label: 'Rejected' },
]

const VTEX_LINKED_OPTIONS = [
  { value: '', label: 'All Products' },
  { value: '1', label: 'Linked to Marketplace' },
  { value: '0', label: 'Not Linked' },
]

// Added by MDM 2026-10-20, at our request.
const SORT_FIELD_OPTIONS = [
  { value: '', label: 'Default (recently added)' },
  { value: 'name', label: 'Name' },
  { value: 'sku', label: 'SKU' },
  { value: 'cas_number', label: 'CAS Number' },
  { value: 'hs_code', label: 'HS Code' },
  { value: 'status', label: 'Status' },
  { value: 'created_at', label: 'Date Added' },
]

const STATUS_COLORS = {
  active: '#8BC34A',
  draft: '#FFB300',
  archived: '#9E9E9E',
  pending: '#3b82f6',
  pending_approval: '#3b82f6',
  rejected: '#dc2626',
}

// SKU column folded into the Product cell's details grid (CAS/HS/Origin
// already live there) — Actions stays inline below it, not a dropdown menu:
// only 2-3 actions per row here, so a menu would just add a click without
// the space savings that's worth it on the admin table's longer list.
const COLS = '1fr 150px 150px 150px'

// Small rounded "!" badge — click to reveal its tooltip (not hover, so it
// works the same on touch devices), click again or click anywhere else to
// dismiss. Used wherever a column or control needs a one-line explainer of
// which of the two separate statuses (MDM's own internal workflow status
// vs whether the product is actually published/live on the marketplace in
// VTEX) it's referring to, or what the Tradechem PID/SID actually are.
const InfoDot = ({ tooltip }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%', background: '#94a3b8', color: '#fff',
          fontSize: 10, fontWeight: 700, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
        }}
      >
        !
      </span>
      {open && (
        <div
          style={{
            position: 'absolute', top: '140%', left: '50%', transform: 'translateX(-50%)',
            background: '#142032', color: '#fff', fontSize: 11, lineHeight: 1.4,
            padding: '6px 10px', borderRadius: 4, width: 220, textAlign: 'left',
            boxShadow: '0 2px 10px rgba(0,0,0,0.25)', zIndex: 30,
            // Table headers set textTransform/fontWeight/letterSpacing on
            // themselves, which this popup otherwise inherits since it's
            // rendered as their descendant — reset explicitly so the
            // tooltip text stays plain regardless of where the icon sits.
            textTransform: 'none', fontWeight: 400, letterSpacing: 'normal',
          }}
        >
          {tooltip}
        </div>
      )}
    </span>
  )
}

const L = ({ c }) => (
  <span style={{ fontSize: 11, fontWeight: 700, color: '#666' }}>{c}</span>
)
const Sep = () => (
  <span style={{ fontSize: 11, color: '#ccc', padding: '0 3px' }}>:</span>
)
const V = ({ c }) => (
  <span style={{ fontSize: 11, color: '#333', fontFamily: 'monospace' }}>{c || '-'}</span>
)

const parseResponse = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    return { success: false, error: `Server error (HTTP ${res.status})` }
  }
}

// Minimal RFC4180 CSV parse/serialize — just enough to round-trip a seller's
// own file (quoted fields, embedded commas/newlines, doubled-quote escaping)
// so the Skip-active-SKUs path can drop specific rows and re-upload the
// rest without corrupting anything else in the file.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}

function csvField(value) {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function serializeCsv(rows) {
  return rows.map(r => r.map(csvField).join(',')).join('\r\n')
}

// ── Media modal: list this product's images, add one, remove one. ──
const MediaModal = ({ product, onClose }) => {
  const [media, setMedia] = useState([])
  const [currentSellerId, setCurrentSellerId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const fileInputRef = useRef(null)

  // Prefer the vtex_product_id route once linked; fall back to mdm_product_id
  // otherwise (MDM's mdm-products/{id}/media routes, added 2026-08-18 so
  // sellers can add media before a product is linked to VTEX at all).
  const mediaQuery = product.vtex?.vtex_product_id
    ? `vtexProductId=${encodeURIComponent(product.vtex.vtex_product_id)}`
    : `mdmProductId=${encodeURIComponent(product.id)}`

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(`${BASE}/products/media?${mediaQuery}`)
      .then(parseResponse)
      .then(data => {
        if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
        setMedia(data.media ?? [])
        setCurrentSellerId(data.currentSellerId ?? null)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [product])

  useEffect(() => { load() }, [load])

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${BASE}/products/media?${mediaQuery}`, {
        method: 'POST',
        body: form,
      })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (mediaId) => {
    setDeletingId(mediaId)
    setError(null)
    try {
      const res = await fetch(`${BASE}/products/media?mediaId=${encodeURIComponent(mediaId)}`, { method: 'DELETE' })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      setMedia(prev => prev.filter(m => m.id !== mediaId))
    } catch (err) {
      setError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
    <Modal isOpen centered onClose={onClose} title="Product media">
      <div style={{ minWidth: 700, maxWidth: 900 }}>
        <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, marginBottom: 16 }}>
          {product.name}
        </div>

        {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 12,
            marginBottom: 16,
          }}>
            {media.length === 0 && (
              <div style={{ fontSize: 12, color: '#999', gridColumn: '1 / -1' }}>No images yet.</div>
            )}
            {media.map(m => {
              // Per MDM (2026-08-13): vtex_seller_id: null means
              // admin/marketplace/MDM-added — never show Remove on those,
              // even though our own list call already filters to this
              // seller's own uploads server-side. Their API 403s a delete
              // attempt on anything not owned by the caller regardless, so
              // this is belt-and-braces, not the only thing enforcing it.
              const ownedByMe = m.vtex_seller_id != null && m.vtex_seller_id === currentSellerId
              return (
                <div key={m.id} style={{ position: 'relative', border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
                  <img
                    src={m.url}
                    alt={m.alt ?? ''}
                    onClick={() => setLightboxUrl(m.url)}
                    style={{ width: '100%', height: 100, objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
                  />
                  {ownedByMe && (
                    <button
                      onClick={() => handleDelete(m.id)}
                      disabled={deletingId === m.id}
                      style={{
                        position: 'absolute', top: 4, right: 4,
                        background: 'rgba(220,38,38,0.9)', color: '#fff', border: 'none',
                        borderRadius: 4, fontSize: 10, fontWeight: 700, padding: '2px 6px',
                        cursor: deletingId === m.id ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {deletingId === m.id ? '…' : 'Remove'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          disabled={uploading}
          style={{ display: 'none' }}
          id="mdm-product-media-input"
        />
        <label htmlFor="mdm-product-media-input">
          <Button variation="secondary" isLoading={uploading} onClick={() => fileInputRef.current?.click()}>
            Add image
          </Button>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <Button variation="tertiary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
    {lightboxUrl && ReactDOM.createPortal(
      // Portaled to document.body with its own fixed overlay — sibling
      // positioning inside the Modal risked the same clipping issue hit
      // earlier with a dropdown nested in a scrollable Modal body.
      <div
        onClick={() => setLightboxUrl(null)}
        style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'zoom-out',
        }}
      >
        <img
          src={lightboxUrl}
          alt=""
          style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 4 }}
        />
        <button
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed', top: 20, right: 24,
            background: 'none', border: 'none', color: '#fff',
            fontSize: 28, lineHeight: 1, cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>,
      document.body
    )}
    </>
  )
}

// ── Import modal: upload a CSV, show per-row results. ──
const ImportModal = ({ onClose, onImported }) => {
  const [file, setFile] = useState(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  // Set once the pre-flight check finds SKUs already active or rejected —
  // holds what's needed to either re-upload as-is or rebuild the CSV with
  // those rows dropped, without re-parsing the file a second time.
  const [conflict, setConflict] = useState(null) // { flagged: [{sku,name,status}], rows, skuColIndex }

  const upload = async (uploadFile) => {
    setImporting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('csv_file', uploadFile)
      const res = await fetch(`${BASE}/products/import`, { method: 'POST', body: form })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      setResult(data.result)
      onImported()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  // Parses the CSV client-side, looks up each SKU's *current* status, and
  // stops to warn before touching anything active or rejected — either way,
  // the SKU resets to Pending Approval in both MDM and VTEX, so the seller
  // should confirm first: active means something live gets delisted,
  // rejected means it's being resubmitted for re-review.
  const handleImport = async () => {
    if (!file) return
    setChecking(true)
    setError(null)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (!rows.length) throw new Error('CSV file is empty')
      const header = rows[0].map(h => h.trim().toLowerCase())
      const skuColIndex = header.indexOf('sku')
      if (skuColIndex === -1) throw new Error('CSV has no "sku" column')

      // MDM's bulk CSV endpoint doesn't reject rows missing these — it just
      // accepts them silently (reported by the client: "CSV import accepts
      // products with missing required information without throwing any
      // information"). name/cas_number/hs_code are confirmed required
      // elsewhere in this system (productCaptureHandler.ts's pre-validation,
      // importProductHandler.ts), so block them here the same way blank SKU
      // already is, rather than rely on MDM to catch it.
      const REQUIRED_COLUMNS = [
        { key: 'sku', colIndex: skuColIndex, label: 'SKU' },
        { key: 'name', colIndex: header.indexOf('name'), label: 'Name' },
        { key: 'cas_number', colIndex: header.indexOf('cas_number'), label: 'CAS Number' },
        { key: 'hs_code', colIndex: header.indexOf('hs_code'), label: 'HS Code' },
      ]
      const missingColumns = REQUIRED_COLUMNS.filter(c => c.colIndex === -1)
      if (missingColumns.length) {
        throw new Error(`CSV is missing required column${missingColumns.length > 1 ? 's' : ''}: ${missingColumns.map(c => c.key).join(', ')}`)
      }

      const rowErrors = rows.slice(1).map((r, i) => {
        const missing = REQUIRED_COLUMNS.filter(c => !((r[c.colIndex] ?? '').trim())).map(c => c.label)
        return missing.length ? `line ${i + 2} (missing ${missing.join(', ')})` : null
      }).filter(Boolean)
      if (rowErrors.length) {
        const shown = rowErrors.slice(0, 10)
        const suffix = rowErrors.length > shown.length ? `; +${rowErrors.length - shown.length} more row(s)` : ''
        throw new Error(`CSV has rows missing required fields — ${shown.join('; ')}${suffix}`)
      }

      // Duplicate SKUs within the same file used to pass through silently —
      // the first row created the product, the second quietly overwrote it
      // on the same import run with no warning (client-reported). Flag and
      // block instead of letting one row's data silently clobber another's.
      const allSkus = rows.slice(1).map(r => (r[skuColIndex] ?? '').trim())
      const skuLines = new Map()
      allSkus.forEach((sku, i) => {
        if (!skuLines.has(sku)) skuLines.set(sku, [])
        skuLines.get(sku).push(i + 2)
      })
      const duplicateSkus = [...skuLines.entries()].filter(([, lines]) => lines.length > 1)
      if (duplicateSkus.length) {
        const shown = duplicateSkus.slice(0, 10).map(([sku, lines]) => `${sku} (lines ${lines.join(', ')})`)
        const suffix = duplicateSkus.length > shown.length ? `; +${duplicateSkus.length - shown.length} more` : ''
        throw new Error(`CSV has duplicate SKUs within the file — ${shown.join('; ')}${suffix}. Each SKU should appear once; remove or merge the duplicate rows before importing.`)
      }

      const skus = [...new Set(allSkus)]
      const lookups = await Promise.all(skus.map(async sku => {
        try {
          // sku is a partial-match filter server-side — per_page padded well
          // above 1 so an exact match sharing a prefix with other SKUs isn't
          // pushed off the first page before the client-side exact filter below.
          const res = await fetch(`${BASE}/products-list?sku=${encodeURIComponent(sku)}&per_page=20`)
          const data = await parseResponse(res)
          if (!data.success) return null
          return (data.products ?? []).find(p => p.sku === sku) ?? null
        } catch { return null }
      }))
      const flagged = lookups
        .filter(p => p && (p.status === 'active' || p.status === 'rejected'))
        .map(p => ({ sku: p.sku, name: p.name, status: p.status }))

      if (flagged.length) {
        setConflict({ flagged, rows, skuColIndex })
        return
      }
      await upload(file)
    } catch (err) {
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  const handleConfirmProceed = () => {
    setConflict(null)
    upload(file)
  }

  const handleConfirmSkip = () => {
    const { flagged, rows, skuColIndex } = conflict
    const skipSet = new Set(flagged.map(s => s.sku))
    const filteredRows = [rows[0], ...rows.slice(1).filter(r => !skipSet.has((r[skuColIndex] ?? '').trim()))]
    const csvText = serializeCsv(filteredRows)
    const filteredFile = new File([csvText], file.name, { type: file.type || 'text/csv' })
    setConflict(null)
    if (filteredRows.length <= 1) {
      setError('Nothing left to import — every row in the file was already active or rejected.')
      return
    }
    upload(filteredFile)
  }

  const renderRows = (label, block) => {
    if (!block?.rows?.length) return null
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#142032', marginBottom: 6 }}>
          {label} — {block.summary?.create ?? 0} created, {block.summary?.update ?? 0} updated, {block.summary?.error ?? 0} errors
        </div>
        <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden', maxHeight: 220, overflowY: 'auto' }}>
          {block.rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '50px 1fr 80px 1fr',
                gap: 8,
                padding: '6px 10px',
                borderBottom: '1px solid #eee',
                fontSize: 12,
                color: r.status === 'error' ? '#dc2626' : '#333',
              }}
            >
              <span>{r.line}</span>
              <span>{r.identifier}</span>
              <span style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10 }}>{r.status}</span>
              <span>{r.message}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Modal isOpen centered onClose={onClose} title="Import products">
      <div style={{ minWidth: 600, maxWidth: 700 }}>
        <div style={{
          fontSize: 11, color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0',
          borderRadius: 4, padding: '6px 10px', marginBottom: 14,
        }}>
          Every product created this way starts as <strong>Pending Approval</strong> until an MDM admin reviews it
          — re-uploading an existing SKU later to update it won't undo an approval already given.
        </div>

        <div style={{ marginBottom: 12 }}>
          <a href={SAMPLE_CSV_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
            Download sample CSV →
          </a>
        </div>

        {conflict ? (() => {
          const activeFlagged = conflict.flagged.filter(s => s.status === 'active')
          const rejectedFlagged = conflict.flagged.filter(s => s.status === 'rejected')
          return (
            <div style={{
              fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a',
              borderRadius: 6, padding: '12px 14px', marginBottom: 16,
            }}>
              {activeFlagged.length > 0 && (
                <div style={{ marginBottom: rejectedFlagged.length > 0 ? 14 : 8 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    {activeFlagged.length} SKU{activeFlagged.length > 1 ? 's are' : ' is'} already active
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    Updating {activeFlagged.length > 1 ? 'them' : 'it'} will revert the status back to Pending
                    Approval in both MDM and the marketplace, and the product will be delisted from the marketplace until it's re-approved.
                  </div>
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {activeFlagged.map(s => (
                      <div key={s.sku} style={{ fontFamily: 'monospace' }}>{s.sku} — {s.name}</div>
                    ))}
                  </div>
                </div>
              )}
              {rejectedFlagged.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    {rejectedFlagged.length} SKU{rejectedFlagged.length > 1 ? 's are' : ' is'} currently rejected
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    Updating {rejectedFlagged.length > 1 ? 'them' : 'it'} will resubmit for re-review, resetting the
                    status back to Pending Approval — this wasn't live on the marketplace before, so nothing will be delisted.
                  </div>
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {rejectedFlagged.map(s => (
                      <div key={s.sku} style={{ fontFamily: 'monospace' }}>{s.sku} — {s.name}</div>
                    ))}
                  </div>
                </div>
              )}
              <div>Proceed and update everyone anyway, or skip just these SKUs and import the rest?</div>
            </div>
          )
        })() : !result && (
          <div style={{ marginBottom: 12 }}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={e => {
                const f = e.target.files?.[0] ?? null
                setError(null)
                // accept=".csv,.txt" only hints the OS picker — it doesn't
                // block "All Files" overrides, and gave no feedback at all
                // when a wrong format slipped through (client-reported: no
                // notification shown for a wrong file format). Check the
                // extension ourselves and surface it in the same error slot.
                if (f && !/\.(csv|txt)$/i.test(f.name)) {
                  setError(`Unsupported file type "${f.name}" — please select a .csv file.`)
                  setFile(null)
                  return
                }
                setFile(f)
              }}
            />
          </div>
        )}

        {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}

        {result && (
          <div>
            <div style={{ marginBottom: 12 }}><Alert type="success">Import finished.</Alert></div>
            {renderRows('Products', result.products)}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variation="tertiary" onClick={conflict ? () => setConflict(null) : onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {conflict && (
            <>
              <Button variation="secondary" onClick={handleConfirmSkip} isLoading={importing}>
                Skip these, import the rest
              </Button>
              <Button variation="primary" onClick={handleConfirmProceed} isLoading={importing}>
                Proceed anyway
              </Button>
            </>
          )}
          {!result && !conflict && (
            <Button variation="primary" onClick={handleImport} isLoading={checking || importing} disabled={!file}>
              Import
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// Confirmed live 2026-09-11: MDM's GET /vtex/products returns rejection_reason
// on a rejected product.
function rejectionReason(product) {
  return product?.rejection_reason ?? null
}

// ── Rejection reason modal: shown from the "!" badge next to a Rejected status. ──
const RejectionReasonModal = ({ product, onClose }) => {
  const reason = rejectionReason(product)
  return (
    <Modal isOpen centered onClose={onClose} title="Product rejected">
      <div style={{ minWidth: 600, maxWidth: 700 }}>
        <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, marginBottom: 12 }}>
          {product.name}
        </div>
        {reason ? (
          <div style={{
            fontSize: 13, color: '#7f1d1d', background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 6, padding: '10px 14px',
          }}>
            {reason}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#999' }}>
            No reason was provided for this rejection.
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <Button variation="tertiary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}

const SellerProducts = () => {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  // Live Active/Inactive per linked product, keyed by vtex_product_id —
  // fetched one at a time after the list itself has already rendered, so
  // the list is never blocked waiting on VTEX (see listSellerProducts's own
  // comment). undefined = not checked yet, 'loading' = in flight.
  const [liveStatus, setLiveStatus] = useState({})

  const [nameFilter, setNameFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [casFilter, setCasFilter] = useState('')
  const [hsFilter, setHsFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [linkedFilter, setLinkedFilter] = useState('')
  // sort_direction empty == asc (MDM's own default) — only sent as 'desc'
  // explicitly, so an all-empty filter set still reads as "no active filters".
  const [sortBy, setSortBy] = useState('')
  const [sortDirection, setSortDirection] = useState('')

  const [mediaProduct, setMediaProduct] = useState(null)
  const [documentsProduct, setDocumentsProduct] = useState(null)
  const [showImport, setShowImport] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [priceInventoryProduct, setPriceInventoryProduct] = useState(null)
  const [rejectionProduct, setRejectionProduct] = useState(null)
  const [confirmUnpublishProduct, setConfirmUnpublishProduct] = useState(null)
  const [unpublishingId, setUnpublishingId] = useState(null)
  const [unpublishError, setUnpublishError] = useState(null)
  const [unpublishDone, setUnpublishDone] = useState(false)

  // Live VTEX status — MDM's own status field can't be trusted alone to
  // reflect whether the linked VTEX product is actually Active/Inactive
  // (that's the whole gap this session's deactivation work closes). Shared
  // between the standalone status-check (click the Status tag) and the
  // Revert to Pending confirm, which shows it live too.
  const [statusCheckProduct, setStatusCheckProduct] = useState(null)
  const [vtexStatusLoading, setVtexStatusLoading] = useState(false)
  const [vtexStatusError, setVtexStatusError] = useState(null)
  const [vtexStatusData, setVtexStatusData] = useState(null)

  // Edit Link / Add Link — MDM confirmed (2026-10-08) no client-side
  // debounce is required; their own rate limits are the only backstop. Just
  // loading/error state per call, no cooldown tracking.
  const [editLoadingId, setEditLoadingId] = useState(null)
  const [editLinkError, setEditLinkError] = useState(null)
  const [addLoading, setAddLoading] = useState(false)
  const [addLinkError, setAddLinkError] = useState(null)

  const fetchParamsRef = useRef({ page: 1 })
  const debounceRef = useRef(null)

  // Shown in the banner below — so a stale seller/MDM-id mismatch (like the
  // constellationgroups411 incident, where the cached mdmSellerId pointed at
  // the wrong seller) is visible on the page itself, from this always-fresh
  // force-sync, rather than something only a dev diagnostic could reveal.
  const [sellerInfo, setSellerInfo] = useState(null)

  useEffect(() => {
    fetch(`${BASE}/touch-login`)
      .then(parseResponse)
      .then(data => { if (data.success) setSellerInfo(data) })
      .catch(() => {})
  }, [])

  // Shared by doFetch and the Export button below — both need the table's
  // current filter state turned into the exact same query params, and
  // letting them drift apart would mean "export what's filtered" quietly
  // stops being true.
  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams()
    if (nameFilter) params.set('name', nameFilter)
    if (skuFilter) params.set('sku', skuFilter)
    if (casFilter) params.set('cas_number', casFilter)
    if (hsFilter) params.set('hs_code', hsFilter)
    // MDM treats an omitted status as active-only, not "all statuses" —
    // "All Statuses" here has to send the explicit status=all value to
    // actually mean that (confirmed live 2026-09-11).
    params.set('status', statusFilter || 'all')
    if (linkedFilter) params.set('vtex_linked', linkedFilter)
    if (sortBy) {
      params.set('sort_by', sortBy)
      params.set('sort_direction', sortDirection || 'asc')
    }
    return params
  }, [nameFilter, skuFilter, casFilter, hsFilter, statusFilter, linkedFilter, sortBy, sortDirection])

  const doFetch = useCallback(async () => {
    const p = fetchParamsRef.current.page
    setLoading(true)
    setError(null)
    try {
      const params = buildFilterParams()
      params.set('page', String(p))
      params.set('per_page', String(PER_PAGE))

      const res = await fetch(`${BASE}/products-list?${params.toString()}`)
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      setProducts(data.products ?? [])
      setLiveStatus({})
      setTotal(data.total ?? 0)
      setPage(p)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameFilter, skuFilter, casFilter, hsFilter, statusFilter, linkedFilter, sortBy, sortDirection])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchParamsRef.current = { page: 1 }
      doFetch()
    }, DEBOUNCE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameFilter, skuFilter, casFilter, hsFilter, statusFilter, linkedFilter, sortBy, sortDirection])

  // Fills in each linked product's real Published state one at a time,
  // after the list has already rendered — the list load itself never waits
  // on VTEX (see listSellerProducts's own comment); this is what actually
  // resolves "published" vs "pending" per row, progressively.
  useEffect(() => {
    let cancelled = false
    const toCheck = products.filter(p => p.vtex?.linked && p.vtex?.vtex_product_id && liveStatus[p.vtex.vtex_product_id] === undefined)
    if (toCheck.length === 0) return

    ;(async () => {
      for (const p of toCheck) {
        if (cancelled) return
        const id = p.vtex.vtex_product_id
        setLiveStatus(s => ({ ...s, [id]: 'loading' }))
        try {
          const res = await fetch(`${BASE}/products/vtex-status?vtexProductId=${encodeURIComponent(id)}`)
          const data = await parseResponse(res)
          if (cancelled) return
          setLiveStatus(s => ({ ...s, [id]: data.success ? !!data.isActive : 'error' }))
        } catch {
          if (!cancelled) setLiveStatus(s => ({ ...s, [id]: 'error' }))
        }
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products])

  const handleNextPage = () => {
    fetchParamsRef.current = { page: page + 1 }
    doFetch()
  }
  const handlePrevPage = () => {
    fetchParamsRef.current = { page: Math.max(1, page - 1) }
    doFetch()
  }
  const handleRefresh = () => {
    doFetch()
  }
  const handleClearFilters = () => {
    setNameFilter('')
    setSkuFilter('')
    setCasFilter('')
    setHsFilter('')
    setStatusFilter('')
    setLinkedFilter('')
    setSortBy('')
    setSortDirection('')
  }
  const handleSortDirectionToggle = () => setSortDirection(d => (d === 'desc' ? '' : 'desc'))
  const hasActiveFilters = !!(nameFilter || skuFilter || casFilter || hsFilter || statusFilter || linkedFilter || sortBy)

  const handleUnpublish = async (product) => {
    setUnpublishingId(product.id)
    setUnpublishError(null)
    try {
      const params = new URLSearchParams({ mdmProductId: product.id })
      if (product.vtex?.vtex_product_id) params.set('vtexProductId', product.vtex.vtex_product_id)
      const res = await fetch(`${BASE}/products/unpublish?${params.toString()}`, { method: 'POST' })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      doFetch()
      // MDM side succeeded — vtexDeactivateError means only the VTEX-side
      // deactivation failed. Keep the modal open with a "done" state
      // (single Close, no re-triggering the already-Pending MDM call)
      // instead of closing it, same as the marketplace admin's version.
      if (data.vtexDeactivateError) {
        setUnpublishError(`Reverted to Pending in MDM, but deactivating the marketplace product failed: ${data.vtexDeactivateError}`)
        setUnpublishDone(true)
        return
      }
      setConfirmUnpublishProduct(null)
    } catch (err) {
      setUnpublishError(err.message)
    } finally {
      setUnpublishingId(null)
    }
  }

  // Shared by the standalone Status-tag click and the Revert to Pending
  // confirm — both need the same live read of the linked VTEX product.
  const fetchVtexStatus = async (product) => {
    setVtexStatusData(null)
    setVtexStatusError(null)
    if (!product.vtex?.vtex_product_id) return
    setVtexStatusLoading(true)
    try {
      const res = await fetch(`${BASE}/products/vtex-status?vtexProductId=${encodeURIComponent(product.vtex.vtex_product_id)}`)
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      setVtexStatusData(data)
    } catch (err) {
      setVtexStatusError(err.message)
    } finally {
      setVtexStatusLoading(false)
    }
  }

  const handleStatusClick = (product) => {
    setStatusCheckProduct(product)
    fetchVtexStatus(product)
  }

  const handleRevertClick = (product) => {
    setConfirmUnpublishProduct(product)
    setUnpublishDone(false)
    fetchVtexStatus(product)
  }

  // Used to open a blank tab synchronously then redirect it once the fetch
  // resolved, to dodge popup blockers — but that blank/loading tab sat there
  // for 3-4 seconds with nothing in it, which read as broken rather than
  // loading. Shows a modal with a spinner in THIS tab while MDM issues the
  // link instead, and only opens the new tab once there's a real URL to
  // send it to — nothing to stare at in the meantime.
  const handleEditClick = async (product) => {
    setEditLoadingId(product.id)
    setEditLinkError(null)
    try {
      const res = await fetch(`${BASE}/products/edit-link?mdmProductId=${encodeURIComponent(product.id)}`, { method: 'POST' })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      window.open(data.url, '_blank')
    } catch (err) {
      setEditLinkError(err.message)
    } finally {
      setEditLoadingId(null)
    }
  }

  const handleAddClick = async () => {
    setAddLoading(true)
    setAddLinkError(null)
    try {
      const res = await fetch(`${BASE}/products/add-link`, { method: 'POST' })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      window.open(data.url, '_blank')
    } catch (err) {
      setAddLinkError(err.message)
    } finally {
      setAddLoading(false)
    }
  }

  // Exports whatever currently matches the table's filters (not just the
  // current page) — same columns+rows shape the backend returns, turned
  // into a CSV client-side with this file's own serializeCsv (already used
  // for the Skip-active-SKUs reupload path) and handed to the browser as a
  // download via a throwaway Blob URL.
  const handleExportClick = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const params = buildFilterParams()
      const res = await fetch(`${BASE}/products/export?${params.toString()}`)
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)

      const csv = serializeCsv([data.columns, ...data.rows])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `my-products-export-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const totalFrom = total === 0 ? 0 : (page - 1) * PER_PAGE + 1
  const totalTo = Math.min(page * PER_PAGE, total)

  return (
    <div className="pa6">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#142032', marginBottom: 4 }}>My Products</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 24 }}>Your products, synced with MDM.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span title="Currently not stable — moved to phase 2">
            <Button variation="secondary" onClick={handleExportClick} isLoading={exporting} disabled>
              + Export products
            </Button>
          </span>
          <Button variation="secondary" onClick={() => setShowImport(true)}>+ Import products</Button>
          <Button variation="primary" onClick={handleAddClick} isLoading={addLoading}>
            + Add product
          </Button>
        </div>
      </div>
      {addLinkError && <div style={{ marginTop: 12 }}><Alert type="error" onClose={() => setAddLinkError(null)}>{addLinkError}</Alert></div>}
      {exportError && <div style={{ marginTop: 12 }}><Alert type="error" onClose={() => setExportError(null)}>{exportError}</Alert></div>}

      {sellerInfo && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0',
          borderRadius: 6, padding: '6px 12px', margin: '16px 0',
        }}>
          {sellerInfo.logoUrl ? (
            <img
              src={sellerInfo.logoUrl} alt=""
              style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
            />
          ) : (
            // Same initial-letter placeholder VTEX's own Company Information
            // screen uses when no logo is uploaded.
            <div style={{
              width: 24, height: 24, borderRadius: 4, background: '#cbd5e1', color: '#475569',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}>
              {(sellerInfo.companyName || sellerInfo.vtexAccount || '?').charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 10px' }}>
            <strong style={{ color: '#142032' }}>{sellerInfo.companyName || sellerInfo.vtexAccount}</strong>
            <span>{sellerInfo.vtexAccount}</span>
            {sellerInfo.email && <span>· {sellerInfo.email}</span>}
            <span>· Seller: {sellerInfo.sellerName || 'Not defined'}</span>
            <span>· MDM ID <strong style={{ fontFamily: 'monospace' }}>{sellerInfo.mdmSellerId}</strong></span>
            <span style={{ color: '#94a3b8' }}>· synced just now</span>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        // Fixed 3 per row rather than auto-fit — auto-fit let everything
        // cram into one wide row on a large screen instead of a consistent
        // grid. Sort By/direction moved out of this grid and into the
        // refresh/pagination row instead (2026-10-20).
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
        marginBottom: 16,
      }}>
        <Input label="Product Name" placeholder="Search name..." value={nameFilter} onChange={e => setNameFilter(e.target.value)} />
        <Input label="SKU" placeholder="Search SKU..." value={skuFilter} onChange={e => setSkuFilter(e.target.value)} />
        <Input label="CAS Number" placeholder="e.g. 8050-09-07" value={casFilter} onChange={e => setCasFilter(e.target.value)} />
        <Input label="HS Code" placeholder="e.g. 3806.10.00" value={hsFilter} onChange={e => setHsFilter(e.target.value)} />
        <Dropdown label="Status" options={STATUS_OPTIONS} value={statusFilter} onChange={(_, v) => setStatusFilter(v)} />
        <Dropdown label="Marketplace Link" options={VTEX_LINKED_OPTIONS} value={linkedFilter} onChange={(_, v) => setLinkedFilter(v)} />
      </div>

      {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}
      {editLinkError && <div style={{ marginBottom: 12 }}><Alert type="error" onClose={() => setEditLinkError(null)}>{editLinkError}</Alert></div>}

      <div className="mb3" style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
        <div>
          {hasActiveFilters && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: '#666' }}>
                {total} products match your filters
              </span>
              <button
                onClick={handleClearFilters}
                style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '3px 12px', fontSize: 12, cursor: 'pointer', color: '#555' }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#888', flexShrink: 0 }}>Sort:</span>
          {/* Plain native <select>, not vtex.styleguide's Dropdown — that
              component always renders its own label above the input,
              which can't be made to match a plain 32px button's height.
              Sized to exactly match the refresh button next to it. */}
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{
              height: 32, boxSizing: 'border-box', padding: '0 8px',
              border: '1px solid #d5d7d9', borderRadius: 4, background: '#fff',
              fontSize: 13, color: '#142032', cursor: 'pointer',
            }}
          >
            {SORT_FIELD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            type="button"
            onClick={handleSortDirectionToggle}
            disabled={!sortBy}
            title={sortDirection === 'desc' ? 'Descending — click for ascending' : 'Ascending — click for descending'}
            style={{
              height: 32, width: 32, flexShrink: 0, marginRight: 9,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              boxSizing: 'border-box', padding: 0,
              border: '1px solid #d5d7d9', borderRadius: 4, background: '#fff',
              cursor: sortBy ? 'pointer' : 'not-allowed',
              opacity: sortBy ? 1 : 0.4,
              fontSize: 15, lineHeight: 1,
            }}
          >
            {sortDirection === 'desc' ? '↓' : '↑'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh with current filters"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              boxSizing: 'border-box',
              background: '#fff',
              border: '1px solid #dfe3e8',
              borderRadius: 4,
              padding: 0,
              fontSize: 16,
              lineHeight: 1,
              marginRight: 15,
              cursor: loading ? 'default' : 'pointer',
              color: '#555',
              opacity: loading ? 0.6 : 1,
            }}
          >
            ↻
          </button>
          {/* Pagination's own internal markup carries a Tachyons "pt5"
              (padding-top: 4rem = 64px) on its content wrapper — real, not a
              layout bug on our side (confirmed by inspecting the rendered
              DOM). That pushes its visible content down inside a much taller
              box than our 32px button, which just LOOKS like two stacked rows
              since alignItems:center centers the button against that inflated
              height. Pulling the whole component up by the same 64px cancels
              it back out. */}
          {/* Confirmed live (2026-10-08, via browser inspect) that -64 alone
              wasn't quite enough — an extra margin-top: 47px on Pagination's
              own inner ".pt5" row was also needed to land it level with the
              button. That inner div is rendered by Pagination itself with no
              prop to style it directly, so the override goes through a scoped
              <style> tag keyed to this one wrapper's unique class, rather than
              a global rule that would also hit the second, unrelated
              Pagination instance below the table. */}
          <style>{`.seller-products-top-pagination .pt5 { margin-top: 47px; }`}</style>
          <div className="seller-products-top-pagination" style={{ marginTop: -64 }}>
            <Pagination
              currentItemFrom={totalFrom}
              currentItemTo={totalTo}
              textOf="of"
              totalItems={total}
              onNextClick={handleNextPage}
              onPrevClick={handlePrevPage}
            />
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', padding: '10px 16px',
          background: '#f0f4f8', borderBottom: '2px solid #dce4ec', fontSize: 11, fontWeight: 700,
          color: '#6b7c93', letterSpacing: '0.6px', textTransform: 'uppercase',
        }}>
          <div>Product</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            MDM Status
            <InfoDot tooltip="MDM's own internal workflow status for this product." />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            Published
            <InfoDot tooltip="Whether this product is published and live on the marketplace." />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            PID / SID
            <InfoDot tooltip="Once your product is published, the marketplace gives it a new Product ID (PID) and SKU ID (SID) of its own." />
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : products.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#999', fontSize: 14 }}>
            No products match your filters.
          </div>
        ) : (
          products.map((p, idx) => {
            const origin = p.origin_countries?.length
              ? p.origin_countries.map(c => c.name).join(', ')
              : null
            // Published state resolves progressively — see the liveStatus
            // effect above. Not checked yet / still in flight both read as
            // "checking", not "pending", so the badge doesn't flash a wrong
            // answer before the real one arrives.
            const rowLiveStatus = p.vtex?.linked ? liveStatus[p.vtex?.vtex_product_id] : undefined
            const isChecking = p.vtex?.linked && (rowLiveStatus === undefined || rowLiveStatus === 'loading')
            const isPublished = p.vtex?.linked && rowLiveStatus === true
            // Edit/Revert to Pending default to hidden while the live check
            // is still in flight, so they never flash on then immediately
            // disappear once the real state comes back. Once resolved:
            // active + published = nothing to do via MDM, both stay hidden;
            // anything else, Edit reappears, and Revert to Pending reappears
            // too but only for an active (not yet published) product —
            // rejected/pending/draft show Edit the same way, just never
            // Revert to Pending (that's only ever meaningful from active).
            const fullyLive = p.status === 'active' && isPublished
            const showEdit = !isChecking && !fullyLive
            const showRevert = !isChecking && p.status === 'active' && !isPublished
            return (
            <div
              key={p.id ?? idx}
              style={{
                display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', padding: '14px 16px',
                borderBottom: '1px solid #eee', alignItems: 'start',
                background: idx % 2 === 0 ? '#fff' : '#fafcfe',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#142032', marginBottom: 7 }}>{p.name}</div>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'max-content max-content minmax(0,1fr)',
                  rowGap: 4, alignItems: 'baseline',
                }}>
                  <L c="SKU" /><Sep /><V c={p.sku} />
                  <L c="CAS" /><Sep /><V c={p.cas_number} />
                  <L c="HS" /><Sep /><V c={p.hs_code} />
                  <L c="Origin" /><Sep /><V c={origin} />
                </div>
                {/* A dropdown menu exists to save space when there are many
                    actions (that's the admin table's situation) — this row
                    only ever has 2-3, so a menu just adds a click for no
                    space benefit. Plain inline buttons instead, in the same
                    spot the menu would have been. */}
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {SHOW_MEDIA_DOCUMENTS_BUTTONS && (
                    <>
                      <button
                        onClick={() => setMediaProduct(p)}
                        style={{
                          background: '#fff', border: '1px solid #9333ea', borderRadius: 4, padding: '3px 10px',
                          fontSize: 11, fontWeight: 600, color: '#9333ea', cursor: 'pointer',
                        }}
                      >
                        Media
                      </button>
                      <button
                        onClick={() => setDocumentsProduct(p)}
                        style={{
                          background: '#fff', border: '1px solid #0891b2', borderRadius: 4, padding: '3px 10px',
                          fontSize: 11, fontWeight: 600, color: '#0891b2', cursor: 'pointer',
                        }}
                      >
                        Documents
                      </button>
                    </>
                  )}
                  {/* Once a product is active AND published on the marketplace,
                      editing/reverting through MDM no longer applies — the
                      marketplace now owns the live listing. */}
                  {showEdit && (
                    <button
                      onClick={() => handleEditClick(p)}
                      disabled={editLoadingId === p.id}
                      title="Edit this product"
                      style={{
                        background: '#fff', border: '1px solid #3f7bbf', borderRadius: 4, padding: '3px 10px',
                        fontSize: 11, fontWeight: 600, color: '#3f7bbf',
                        cursor: editLoadingId === p.id ? 'not-allowed' : 'pointer',
                        opacity: editLoadingId === p.id ? 0.6 : 1,
                      }}
                    >
                      {editLoadingId === p.id ? '…' : 'Edit'}
                    </button>
                  )}
                  <button
                    onClick={() => setPriceInventoryProduct(p)}
                    title="Manage this product's price and inventory. Other fields are only editable until your product is approved — after approval, you won't be able to change them."
                    style={{
                      background: '#fff', border: '1px solid #16a34a', borderRadius: 4, padding: '3px 10px',
                      fontSize: 11, fontWeight: 600, color: '#16a34a', cursor: 'pointer',
                    }}
                  >
                    Price &amp; Inventory
                  </button>
                  {p.status === 'rejected' && (
                    <button
                      onClick={() => setRejectionProduct(p)}
                      style={{
                        background: '#fff', border: '1px solid #dc2626', borderRadius: 4, padding: '3px 10px',
                        fontSize: 11, fontWeight: 600, color: '#dc2626', cursor: 'pointer',
                      }}
                    >
                      View rejection reason
                    </button>
                  )}
                  {showRevert && (
                    <>
                      <button
                        onClick={() => handleRevertClick(p)}
                        title="Revert to Pending Approval"
                        style={{
                          background: '#fff', border: '1px solid #b45309', borderRadius: 4, padding: '3px 10px',
                          fontSize: 11, fontWeight: 600, color: '#b45309', cursor: 'pointer',
                        }}
                      >
                        Revert to Pending
                      </button>
                      <InfoDot tooltip="Internal product status." />
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 2 }}>
                <span onClick={() => handleStatusClick(p)} style={{ cursor: 'pointer' }} title="Click to check live MDM + marketplace status">
                  <Tag bgColor={STATUS_COLORS[p.status] ?? '#9E9E9E'} color="#fff">{p.status}</Tag>
                </span>
                {p.status === 'rejected' && (
                  <button
                    onClick={() => setRejectionProduct(p)}
                    title="View rejection reason"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 16, height: 16, borderRadius: '50%',
                      background: '#dc2626', color: '#fff', border: 'none',
                      fontSize: 11, fontWeight: 700, lineHeight: 1, padding: 0,
                      cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    !
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 2 }}>
                {/* Live-checked per row, progressively (not just "linked")
                    — confirmed live 2026-10-22: a linked product can still
                    be Inactive in VTEX, so "published" only shows once
                    that's actually confirmed. */}
                {isChecking ? (
                  <Tag bgColor="#e2e8f0" color="#64748b">checking…</Tag>
                ) : (
                  <Tag bgColor={isPublished ? '#8BC34A' : '#9E9E9E'} color="#fff">
                    {isPublished ? 'published' : 'pending'}
                  </Tag>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#666', paddingTop: 2, fontFamily: 'monospace', textAlign: 'center' }}>
                {p.vtex?.linked
                  // SID shows "-" until MDM's own GET /vtex/products starts
                  // returning vtex_sku_id on read (their write side already
                  // accepts it as of 2026-10-15, read side doesn't echo it
                  // back yet) — this will pick it up automatically the
                  // moment that's live, no further change needed here.
                  ? `${p.vtex.vtex_product_id} / ${p.vtex.vtex_sku_id ?? '-'}`
                  : <span style={{ fontFamily: 'inherit' }}>Not Linked</span>}
              </div>
            </div>
            )
          })
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <Pagination
          currentItemFrom={totalFrom}
          currentItemTo={totalTo}
          textOf="of"
          totalItems={total}
          onNextClick={handleNextPage}
          onPrevClick={handlePrevPage}
        />
      </div>

      {(editLoadingId !== null || addLoading) && (
        <Modal isOpen centered onClose={() => {}} title="One moment">
          <div style={{ minWidth: 360, textAlign: 'center', padding: '12px 0 4px' }}>
            <Spinner />
            <div style={{ marginTop: 16, fontSize: 13, color: '#475569' }}>
              Generating a one-time link…
            </div>
          </div>
        </Modal>
      )}
      {mediaProduct && <MediaModal product={mediaProduct} onClose={() => setMediaProduct(null)} />}
      {documentsProduct && <DocumentsModal product={documentsProduct} onClose={() => setDocumentsProduct(null)} />}
      {priceInventoryProduct && <PriceInventoryModal product={priceInventoryProduct} onClose={() => setPriceInventoryProduct(null)} />}
      {rejectionProduct && <RejectionReasonModal product={rejectionProduct} onClose={() => setRejectionProduct(null)} />}
      {confirmUnpublishProduct && (
        <Modal
          isOpen
          centered
          onClose={() => { setConfirmUnpublishProduct(null); setUnpublishError(null); setUnpublishDone(false) }}
          title="Revert to Pending Approval"
        >
          <div style={{ minWidth: 600, maxWidth: 700 }}>
            <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, marginBottom: 12 }}>
              {confirmUnpublishProduct.name}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <Tag bgColor="#3b82f6" color="#fff">Pending Approval — MDM</Tag>
              <Tag bgColor="#dc2626" color="#fff">Delisted from TradeChem Marketplace</Tag>
            </div>
            {/* Live current VTEX status, fetched when this modal opens — this app
                can now deactivate the VTEX product directly (confirmed live
                2026-10-12), so this isn't just the post-action intent anymore,
                it's what's about to actually happen. */}
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 14 }}>
              Current marketplace status:{' '}
              {!confirmUnpublishProduct.vtex?.vtex_product_id ? (
                <span style={{ color: '#999' }}>not linked — nothing to deactivate on the marketplace</span>
              ) : vtexStatusLoading ? (
                <Spinner size={14} />
              ) : vtexStatusError ? (
                <span style={{ color: '#dc2626' }}>couldn't check — {vtexStatusError}</span>
              ) : (
                <Tag bgColor={vtexStatusData?.isActive ? '#8BC34A' : '#9E9E9E'} color="#fff">
                  {vtexStatusData?.isActive ? 'active' : 'inactive'}
                </Tag>
              )}
            </div>
            <div style={{ fontSize: 13, color: '#475569', marginBottom: 16 }}>
              This reverts the product's status back to Pending Approval in MDM for re-review. If it's linked to a marketplace product, that product is also deactivated and removed from the live TradeChem Marketplace storefront. Are you sure you want to continue?
            </div>
            {unpublishError && <div style={{ marginBottom: 12 }}><Alert type={unpublishDone ? 'warning' : 'error'}>{unpublishError}</Alert></div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {unpublishDone ? (
                <Button variation="primary" onClick={() => { setConfirmUnpublishProduct(null); setUnpublishError(null); setUnpublishDone(false) }}>
                  Close
                </Button>
              ) : (
                <>
                  <Button
                    variation="tertiary"
                    onClick={() => { setConfirmUnpublishProduct(null); setUnpublishError(null) }}
                    disabled={unpublishingId === confirmUnpublishProduct.id}
                  >
                    Cancel
                  </Button>
                  <Button
                    variation="danger"
                    onClick={() => handleUnpublish(confirmUnpublishProduct)}
                    isLoading={unpublishingId === confirmUnpublishProduct.id}
                  >
                    Revert to Pending
                  </Button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
      {statusCheckProduct && (
        <ProductStatusModal
          product={statusCheckProduct}
          loading={vtexStatusLoading}
          error={vtexStatusError}
          vtexStatus={vtexStatusData}
          onClose={() => setStatusCheckProduct(null)}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { fetchParamsRef.current = { page: 1 }; doFetch() }}
        />
      )}
    </div>
  )
}

export default SellerProducts
