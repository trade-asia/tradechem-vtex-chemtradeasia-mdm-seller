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

// Real offer status for the Published column (2026-10-24, explicit
// instruction) — five states instead of the old binary published/pending,
// each with its own label, color and tooltip. "approved" only becomes
// "published" once the separate liveStatus IsActive check (see that
// effect's own note) also confirms the product is actually live.
const OFFER_STATE_DISPLAY = {
  not_submitted: { label: 'not submitted', color: '#9E9E9E', tooltip: "Not yet added to your own VTEX catalog — use Price & Inventory to set it up." },
  processing: { label: 'processing', color: '#3b82f6', tooltip: 'Offer is processing for validation' },
  pending: { label: 'pending', color: '#9E9E9E', tooltip: 'Offer is pending by marketplace admin' },
  rejected: { label: 'rejected', color: '#dc2626', tooltip: 'Offer is rejected' },
  approved: { label: 'approved', color: '#FFB300', tooltip: 'Offer is approved but product is not published or product status is not active' },
  published: { label: 'published', color: '#8BC34A', tooltip: 'Product is on marketplace' },
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
// Shared visual tokens for the import modal (2026-10-24, explicit
// instruction: match the font/size/spacing polish already done on the
// marketplace admin app's "Review Offer" modal) — muted uppercase labels,
// a consistent light/dark color pair per row state, one accent color.
const IMPORT_COLORS = {
  text: '#17233d',
  textMuted: '#64748b',
  label: '#8a94a6',
  border: '#e2e6ea',
  bgSubtle: '#f8fafc',
  primary: '#2563eb',
  primaryBg: '#eff6ff',
  primaryBorder: '#bfdbfe',
  successBg: '#f0fdf4',
  successBorder: '#86efac',
  successText: '#166534',
  dangerBg: '#fef2f2',
  dangerBorder: '#fecaca',
  dangerText: '#991b1b',
  warningBg: '#fffbeb',
  warningBorder: '#fde68a',
  warningText: '#92400e',
}

// Mandatory alongside sku/name/cas_number/hs_code (2026-10-24, explicit
// instruction) — brand/category/EAN/weight/dimensions/tax code/price/
// quantity, the exact fields the Price & Inventory wizard's own "create
// product in VTEX" step and price/inventory steps ask for. Captured as
// metadata on import (see setSellerProductImportMetadata on the backend)
// so Price & Inventory can prefill them later instead of making the
// seller re-enter what they already put in the CSV. Brand/category are
// free-text NAMES here, never VTEX's internal numeric ids — the seller
// has no way to know those ids from a spreadsheet.
const METADATA_COLUMNS = [
  { key: 'brand', label: 'Brand' },
  { key: 'category', label: 'Category' },
  { key: 'ean', label: 'EAN' },
  { key: 'package_weight', label: 'Package Weight' },
  { key: 'package_width', label: 'Package Width' },
  { key: 'package_height', label: 'Package Height' },
  { key: 'package_length', label: 'Package Length' },
  { key: 'tax_code', label: 'Tax Code' },
  { key: 'price', label: 'Price' },
  { key: 'quantity', label: 'Quantity' },
]
const BASE_REQUIRED_COLUMNS = [
  { key: 'sku', label: 'SKU' },
  { key: 'name', label: 'Name' },
  { key: 'cas_number', label: 'CAS Number' },
  { key: 'hs_code', label: 'HS Code' },
]
const ALL_REQUIRED_COLUMNS = [...BASE_REQUIRED_COLUMNS, ...METADATA_COLUMNS]

// Generated client-side rather than linked to the external sample file
// (2026-10-24) — that file lives outside this app's own repo and can't be
// kept in sync with the current required-column set from here, so an
// always-correct sample is built on the fly instead.
function buildSampleCsvBlob() {
  const header = ALL_REQUIRED_COLUMNS.map(c => c.key)
  const example = [
    'SAMPLE-SKU-001', 'Sample Chemical A', '104-76-7', '2905.16',
    'Sample Brand', 'Sample Category', '1234567890123', '12', '10', '10', '10', '2905.16.00', '100', '50',
  ]
  return new Blob([serializeCsv([header, example])], { type: 'text/csv' })
}

// Portal-rendered to document.body (2026-10-25, explicit instruction) —
// the badge lives inside the import rows list, which scrolls inside a
// fixed-height container (see ImportModal); an absolutely-positioned
// tooltip anchored to that ancestor was getting clipped by the container's
// own overflow the moment it scrolled. Positioning off the icon's real
// getBoundingClientRect, fixed, and re-measured on scroll/resize keeps it
// anchored and always fully visible regardless of scroll position.
const ImportErrorBadge = ({ message }) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const iconRef = useRef(null)
  const tooltipRef = useRef(null)
  const width = 280

  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = iconRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12)
      setPos({ top: rect.bottom + 9, left, arrowLeft: rect.left + rect.width / 2 - left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    const onDocClick = e => {
      if (iconRef.current?.contains(e.target)) return
      if (tooltipRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [open])

  return (
    <span style={{ position: 'relative', display: 'inline-flex', marginLeft: 6 }}>
      <span
        ref={iconRef}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title="Click for details"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 15, height: 15, borderRadius: '50%', background: IMPORT_COLORS.dangerText, color: '#fff',
          fontSize: 10, fontWeight: 700, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
        }}
      >
        !
      </span>
      {open && pos && ReactDOM.createPortal(
        <div
          ref={tooltipRef}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width, zIndex: 10002,
            background: '#1f2430', color: '#f8fafc', fontSize: 12.5, fontWeight: 500, lineHeight: 1.55,
            padding: '11px 14px', borderRadius: 8, textAlign: 'left',
            borderLeft: `3px solid ${IMPORT_COLORS.dangerText}`,
            boxShadow: '0 12px 28px rgba(15,23,42,0.4)',
          }}
        >
          <div
            style={{
              position: 'absolute', top: -5, left: Math.min(Math.max(10, pos.arrowLeft - 5), width - 20),
              width: 10, height: 10, background: '#1f2430', transform: 'rotate(45deg)',
              borderTop: '1px solid rgba(255,255,255,0.06)', borderLeft: '1px solid rgba(255,255,255,0.06)',
            }}
          />
          {message || 'Unknown error'}
        </div>,
        document.body
      )}
    </span>
  )
}

const IMPORT_ROW_STEP_LABELS = {
  pending: 'Waiting…',
  creating_product: 'Creating product…',
  creating_metadata: 'Creating metadata…',
  done: 'Done',
}

const ImportModal = ({ onClose, onImported }) => {
  const [file, setFile] = useState(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)
  // Set once the pre-flight check finds SKUs already active or rejected —
  // holds what's needed to either re-upload as-is or rebuild the CSV with
  // those rows dropped, without re-parsing the file a second time.
  const [conflict, setConflict] = useState(null) // { flagged: [{sku,name,status}], rows, header, colIndex }
  // One entry per CSV data row, updated live as the import proceeds
  // (2026-10-24, explicit instruction: real-time, step-by-step progress,
  // not one big result dump at the end). header/csvRow are kept per row
  // so the end-of-run error report can be built without re-parsing the
  // file.
  const [rows, setRows] = useState([]) // [{line, sku, name, status, error, header, csvRow}]

  const updateRow = (i, patch) => {
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  // Runs the whole file one row at a time: each row gets its own
  // single-row CSV POSTed to the SAME import endpoint MDM already
  // validates/creates through (no new, unconfirmed MDM endpoint needed —
  // the bulk endpoint already proves `sku` and every other column works,
  // this just calls it with one data row instead of many), then, if that
  // row has any metadata values, a follow-up call saves them. Both steps
  // update that row's own status immediately, so the table reflects real
  // progress rather than a single result at the very end.
  const runImport = async (dataRows, header, colIndex) => {
    setImporting(true)
    setError(null)
    const initial = dataRows.map((r, i) => ({
      line: i + 2,
      sku: (r[colIndex.sku] ?? '').trim(),
      name: (r[colIndex.name] ?? '').trim(),
      status: 'pending',
      error: null,
      header,
      csvRow: r,
    }))
    setRows(initial)

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i]
      updateRow(i, { status: 'creating_product' })

      let productResult
      try {
        const miniCsv = serializeCsv([header, r])
        const miniFile = new File([miniCsv], 'row.csv', { type: 'text/csv' })
        const form = new FormData()
        form.append('csv_file', miniFile)
        const res = await fetch(`${BASE}/products/import`, { method: 'POST', body: form })
        productResult = await parseResponse(res)
      } catch (err) {
        productResult = { success: false, error: err.message }
      }
      if (!productResult.success) {
        updateRow(i, { status: 'error', error: productResult.detail ? `${productResult.error}: ${productResult.detail}` : (productResult.error || 'Import failed') })
        continue
      }
      const mdmRow = productResult.result?.products?.rows?.[0]
      if (mdmRow && mdmRow.status === 'error') {
        updateRow(i, { status: 'error', error: mdmRow.message || 'Import failed' })
        continue
      }

      const metadata = {}
      METADATA_COLUMNS.forEach(c => {
        const v = (r[colIndex[c.key]] ?? '').trim()
        if (v) metadata[c.key] = v
      })

      if (Object.keys(metadata).length) {
        updateRow(i, { status: 'creating_metadata' })
        try {
          const sku = (r[colIndex.sku] ?? '').trim()
          const lookupRes = await fetch(`${BASE}/products-list?sku=${encodeURIComponent(sku)}&per_page=20`)
          const lookupData = await parseResponse(lookupRes)
          const product = (lookupData.products ?? []).find(p => p.sku === sku)
          if (!product) throw new Error("Product was created but couldn't be found again to save its details")
          const metaRes = await fetch(`${BASE}/products/import-metadata`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mdmProductId: product.id, metadata }),
          })
          const metaData = await parseResponse(metaRes)
          if (!metaData.success) throw new Error(metaData.detail ? `${metaData.error}: ${metaData.detail}` : metaData.error)
        } catch (err) {
          updateRow(i, { status: 'error', error: err.message })
          continue
        }
      }

      updateRow(i, { status: 'done', error: null })
    }

    setImporting(false)
    setDone(true)
    onImported()
  }

  // Parses the CSV client-side, checks every required column (base +
  // metadata — all mandatory, 2026-10-24 explicit instruction) is present
  // and filled, blocks duplicate SKUs within the file, then looks up each
  // SKU's *current* status and stops to warn before touching anything
  // active or rejected — either way the SKU resets to Pending Approval in
  // both MDM and VTEX, so the seller should confirm first: active means
  // something live gets delisted, rejected means it's being resubmitted.
  const handleImport = async () => {
    if (!file) return
    setChecking(true)
    setError(null)
    try {
      const text = await file.text()
      const parsedRows = parseCsv(text)
      if (!parsedRows.length) throw new Error('CSV file is empty')
      const header = parsedRows[0].map(h => h.trim().toLowerCase())
      const colIndex = {}
      ALL_REQUIRED_COLUMNS.forEach(c => { colIndex[c.key] = header.indexOf(c.key) })

      const missingColumns = ALL_REQUIRED_COLUMNS.filter(c => colIndex[c.key] === -1)
      if (missingColumns.length) {
        throw new Error(`CSV is missing required column${missingColumns.length > 1 ? 's' : ''}: ${missingColumns.map(c => c.key).join(', ')}`)
      }

      const dataRows = parsedRows.slice(1)
      const rowErrors = dataRows.map((r, i) => {
        const missing = ALL_REQUIRED_COLUMNS.filter(c => !((r[colIndex[c.key]] ?? '').trim())).map(c => c.label)
        return missing.length ? `line ${i + 2} (missing ${missing.join(', ')})` : null
      }).filter(Boolean)
      if (rowErrors.length) {
        const shown = rowErrors.slice(0, 10)
        const suffix = rowErrors.length > shown.length ? `; +${rowErrors.length - shown.length} more row(s)` : ''
        throw new Error(`CSV has rows missing required fields — ${shown.join('; ')}${suffix}`)
      }

      // CAS number format (2026-10-24, explicit instruction: "CSV must
      // contain valid CAS number") — standard CAS Registry Number shape,
      // digits-digits-checkdigit (e.g. "104-76-7"). MDM's own import
      // endpoint doesn't validate this at all (see the duplicate-SKU note
      // just below — same "accepts silently" behavior), so this is the
      // only check catching an obviously malformed one before import.
      const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/
      const casErrors = dataRows.map((r, i) => {
        const cas = (r[colIndex.cas_number] ?? '').trim()
        return cas && !CAS_FORMAT.test(cas) ? `line ${i + 2} (${cas})` : null
      }).filter(Boolean)
      if (casErrors.length) {
        const shown = casErrors.slice(0, 10)
        const suffix = casErrors.length > shown.length ? `; +${casErrors.length - shown.length} more row(s)` : ''
        throw new Error(`CSV has rows with an invalid CAS number format (expected digits-digits-checkdigit, e.g. 104-76-7) — ${shown.join('; ')}${suffix}`)
      }

      // Duplicate SKUs within the same file used to pass through silently —
      // the first row created the product, the second quietly overwrote it
      // on the same import run with no warning (client-reported). Flag and
      // block instead of letting one row's data silently clobber another's.
      const allSkus = dataRows.map(r => (r[colIndex.sku] ?? '').trim())
      const skuLines = new Map()
      allSkus.forEach((sku, i) => {
        if (!skuLines.has(sku)) skuLines.set(sku, [])
        skuLines.get(sku).push(i + 2)
      })
      const duplicateSkus = [...skuLines.entries()].filter(([, lines]) => lines.length > 1)
      if (duplicateSkus.length) {
        const shown = duplicateSkus.slice(0, 10).map(([sku, lines]) => `${sku} (lines ${lines.join(', ')})`)
        const suffix = duplicateSkus.length > shown.length ? `; +${duplicateSkus.length - shown.length} more` : ''
        throw new Error(`CSV has duplicate SKUs within the file — ${shown.join('; ')}${suffix}. Each SKU should appear once; remove or merge the duplicate rows before importing. SKUs must be unique across the whole system — a duplicate SKU will not be imported.`)
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
        setConflict({ flagged, rows: dataRows, header, colIndex })
        return
      }
      await runImport(dataRows, header, colIndex)
    } catch (err) {
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  const handleConfirmProceed = () => {
    const { rows: dataRows, header, colIndex } = conflict
    setConflict(null)
    runImport(dataRows, header, colIndex)
  }

  const handleConfirmSkip = () => {
    const { flagged, rows: dataRows, header, colIndex } = conflict
    const skipSet = new Set(flagged.map(s => s.sku))
    const filteredRows = dataRows.filter(r => !skipSet.has((r[colIndex.sku] ?? '').trim()))
    setConflict(null)
    if (!filteredRows.length) {
      setError('Nothing left to import — every row in the file was already active or rejected.')
      return
    }
    runImport(filteredRows, header, colIndex)
  }

  // Original CSV + the outcome of each row appended, so a seller can fix
  // just the failed rows and re-upload the same file (2026-10-24, explicit
  // instruction).
  const downloadReport = () => {
    if (!rows.length) return
    const header = [...rows[0].header, 'import_status', 'import_error']
    const outRows = rows.map(r => [...r.csvRow, r.status, r.error ?? ''])
    const blob = new Blob([serializeCsv([header, ...outRows])], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'import-report.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadSample = () => {
    const blob = buildSampleCsvBlob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'product-import-sample.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const successCount = rows.filter(r => r.status === 'done').length
  const errorCount = rows.filter(r => r.status === 'error').length

  // Two steps: "upload" (banner, instructions, file picker/conflict) and
  // "progress" (the live per-row run + result). A row is created the
  // instant runImport starts, so rows.length doubles as the step flag —
  // switching to a dedicated progress view, not appending progress below
  // the instructions on the same screen (2026-10-24, explicit instruction).
  // The content area has a fixed height with its own internal scroll so the
  // modal itself never resizes between steps, or as the instructions/rows
  // list grow taller than it.
  const onUploadStep = !rows.length

  return (
    <Modal isOpen centered onClose={onClose} title="Import Products">
      <div style={{ minWidth: 680, maxWidth: 760, fontFamily: 'inherit' }}>
        <div style={{ height: 480, overflowY: 'auto', paddingRight: 4 }}>
          {onUploadStep ? (
            <>
              <div style={{
                fontSize: 12.5, color: IMPORT_COLORS.primary, background: IMPORT_COLORS.primaryBg,
                border: `1px solid ${IMPORT_COLORS.primaryBorder}`, borderRadius: 8, padding: '12px 14px', marginBottom: 14,
                lineHeight: 1.5,
              }}>
                Every product created this way starts as <strong>Pending Approval</strong> until a <strong>marketplace admin</strong> reviews it.
              </div>

              <div style={{
                background: IMPORT_COLORS.bgSubtle, border: `1px solid ${IMPORT_COLORS.border}`, borderRadius: 8,
                padding: '14px 16px', marginBottom: 16,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: IMPORT_COLORS.label, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Before you upload
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: IMPORT_COLORS.text, lineHeight: 1.7 }}>
                  <li>SKU must be unique across the whole system — rows with a duplicate SKU will not be imported.</li>
                  <li>A row with a duplicate SKU, or no SKU at all, will be flagged as an error.</li>
                  <li>
                    Mandatory columns: <strong>sku, name, cas_number, hs_code</strong>, plus the metadata columns{' '}
                    <strong>{METADATA_COLUMNS.map(c => c.key).join(', ')}</strong> — all are required in the CSV.
                  </li>
                  <li>The CSV must contain a valid CAS number for each row.</li>
                  <li>There are many other details you can add or update once the product exists in the system — the CSV only needs to cover the fields above to get started.</li>
                </ul>
                <button
                  onClick={downloadSample}
                  style={{ background: 'none', border: 'none', color: IMPORT_COLORS.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, marginTop: 10 }}
                >
                  Download sample CSV →
                </button>
              </div>

              {conflict ? (() => {
                const activeFlagged = conflict.flagged.filter(s => s.status === 'active')
                const rejectedFlagged = conflict.flagged.filter(s => s.status === 'rejected')
                return (
                  <div style={{
                    fontSize: 12.5, color: IMPORT_COLORS.warningText, background: IMPORT_COLORS.warningBg,
                    border: `1px solid ${IMPORT_COLORS.warningBorder}`, borderRadius: 8, padding: '14px 16px', marginBottom: 16,
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
              })() : (
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
            </>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: IMPORT_COLORS.text }}>
                  {done
                    ? `Import finished — ${successCount} created, ${errorCount} error${errorCount === 1 ? '' : 's'}`
                    : `Importing… ${successCount + errorCount} of ${rows.length} done`}
                </div>
                {done && errorCount > 0 && (
                  <button
                    onClick={downloadReport}
                    style={{ background: 'none', border: 'none', color: IMPORT_COLORS.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
                  >
                    Download report (fix &amp; re-upload) →
                  </button>
                )}
              </div>
              <div style={{ border: `1px solid ${IMPORT_COLORS.border}`, borderRadius: 8 }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '40px 1fr 1fr 170px', gap: 8, padding: '8px 12px',
                  fontSize: 10, fontWeight: 700, color: IMPORT_COLORS.label, textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: IMPORT_COLORS.bgSubtle, borderBottom: `1px solid ${IMPORT_COLORS.border}`,
                  position: 'sticky', top: 0,
                }}>
                  <span>Line</span><span>SKU</span><span>Name</span><span>Status</span>
                </div>
                {rows.map((r, i) => {
                  const isSuccess = r.status === 'done'
                  const isError = r.status === 'error'
                  const bg = isSuccess ? IMPORT_COLORS.successBg : isError ? IMPORT_COLORS.dangerBg : '#fff'
                  const fg = isSuccess ? IMPORT_COLORS.successText : isError ? IMPORT_COLORS.dangerText : IMPORT_COLORS.text
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'grid', gridTemplateColumns: '40px 1fr 1fr 170px', gap: 8, padding: '8px 12px',
                        borderBottom: `1px solid ${IMPORT_COLORS.border}`, fontSize: 12.5, background: bg, color: fg,
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: IMPORT_COLORS.label }}>{r.line}</span>
                      <span style={{ fontFamily: 'monospace' }}>{r.sku || '—'}</span>
                      <span>{r.name || '—'}</span>
                      <span style={{ display: 'flex', alignItems: 'center', fontWeight: 600 }}>
                        {isError ? 'Error' : isSuccess ? 'Done' : IMPORT_ROW_STEP_LABELS[r.status]}
                        {isError && <ImportErrorBadge message={r.error} />}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Button variation="tertiary" onClick={conflict ? () => setConflict(null) : onClose}>
            {done ? 'Close' : 'Cancel'}
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
          {onUploadStep && !conflict && (
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

// ── Guided product tour (2026-10-24, explicit instruction) ──
// Steps target elements marked with a matching data-tour="..." attribute
// elsewhere in this file. rowOnly steps only run when at least one product
// row exists (they target the first row specifically); if a target is
// missing for any other reason (e.g. Edit hidden for a fully-live product),
// TourOverlay skips that step automatically rather than spotlighting nothing.
const TOUR_STEPS = [
  { id: 'import', title: 'Import products', body: 'Upload a CSV to create or update many products at once. Each row is validated and imported individually, with live progress and a downloadable error report if anything goes wrong.' },
  { id: 'add-product', title: 'Add a product', body: 'Create a single product by hand.' },
  { id: 'filters', title: 'Filters', body: 'Narrow the list down by name, SKU, CAS number, HS code, status, or marketplace link state.' },
  { id: 'pagination', title: 'Pagination', body: 'Move between pages of results.' },
  { id: 'refresh', title: 'Refresh', body: 'Re-fetch the list with your current filters — useful right after an import or a marketplace change.' },
  { id: 'sort', title: 'Sort order', body: 'Choose what to sort by, and toggle ascending or descending.' },
  { id: 'columns', title: 'Table columns', body: "MDM Status is this product's internal workflow stage. Published is its real, live state on the marketplace. PID / SID is the marketplace's own Product ID and SKU ID, once linked." },
  { id: 'price-inventory', title: 'Price & Inventory', body: 'Set price, stock, and the other marketplace-specific fields for this product.', rowOnly: true },
  { id: 'mdm-status', title: 'MDM Status', body: "This product's internal workflow status in MDM.", rowOnly: true },
  { id: 'published', title: 'Published', body: 'The real, live offer status on the marketplace — Pending, Processing, Rejected, Approved, or Published.', rowOnly: true },
  { id: 'link', title: 'PID / SID', body: "Once linked, the marketplace's own Product ID and SKU ID for this product.", rowOnly: true },
  { id: 'edit', title: 'Edit product', body: 'Edit this product in MDM. This disappears once a product is fully live on the marketplace — the marketplace then owns the listing.', rowOnly: true },
]

const TourOverlay = ({ step, onStepChange, hasProducts }) => {
  const steps = React.useMemo(() => TOUR_STEPS.filter(s => !s.rowOnly || hasProducts), [hasProducts])
  const [rect, setRect] = useState(null)

  useEffect(() => {
    if (step === null) return
    if (step >= steps.length) { onStepChange(null); return }
    const current = steps[step]
    const el = document.querySelector(`[data-tour="${current.id}"]`)
    if (!el) {
      onStepChange(step + 1)
      return
    }
    const update = () => setRect(el.getBoundingClientRect())
    update()
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, steps])

  if (step === null || step >= steps.length || !rect) return null

  const current = steps[step]
  const pad = 6
  const spotlightStyle = {
    position: 'fixed',
    top: rect.top - pad, left: rect.left - pad,
    width: rect.width + pad * 2, height: rect.height + pad * 2,
    borderRadius: 8,
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
    pointerEvents: 'none',
    zIndex: 10000,
  }
  const spaceBelow = window.innerHeight - rect.bottom
  const tooltipTop = spaceBelow > 180
    ? rect.bottom + pad * 2 + 8
    : Math.max(12, rect.top - pad * 2 - 160)
  const tooltipLeft = Math.min(Math.max(12, rect.left), window.innerWidth - 332)

  return ReactDOM.createPortal(
    <>
      <div style={spotlightStyle} />
      <div style={{
        position: 'fixed', top: tooltipTop, left: tooltipLeft, width: 320,
        background: '#fff', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 16, zIndex: 10001, fontFamily: 'inherit',
      }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Step {step + 1} of {steps.length}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#142032', marginBottom: 6 }}>{current.title}</div>
        <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.5, marginBottom: 14 }}>{current.body}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={() => onStepChange(null)}
            style={{ background: 'none', border: 'none', color: '#888', fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            Skip tour
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button
                onClick={() => onStepChange(step - 1)}
                style={{ background: '#fff', border: '1px solid #d5d7d9', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, color: '#142032', cursor: 'pointer' }}
              >
                Back
              </button>
            )}
            <button
              onClick={() => onStepChange(step + 1 >= steps.length ? null : step + 1)}
              style={{ background: '#2563eb', border: 'none', borderRadius: 4, padding: '5px 14px', fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer' }}
            >
              {step + 1 >= steps.length ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
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
  // Live, independent check against the seller's OWN VTEX catalog (not
  // MDM) — keyed by mdm sku (2026-10-24, explicit instruction). Same lazy,
  // one-at-a-time pattern as liveStatus above. Drives both the Price &
  // Inventory button color and the Published column's real offer state.
  const [catalogStatus, setCatalogStatus] = useState({})

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

  // Guided product tour (2026-10-24, explicit instruction) — null = not
  // running, otherwise the index into TOUR_STEPS currently spotlighted.
  const [tourStep, setTourStep] = useState(null)

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
    } else {
      // "Default (recently added)" is supposed to mean newest-first, but
      // leaving sort_by/sort_direction unset falls through to MDM's own
      // default ordering, which is oldest-first (ascending) — confirmed
      // live 2026-10-23: newly added products showed up at the end of the
      // list, not the top. Request it explicitly instead of relying on
      // MDM's default to match what the label says.
      params.set('sort_by', 'created_at')
      params.set('sort_direction', 'desc')
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

  // Live, independent check against the seller's own VTEX catalog — one
  // row at a time, after the list has already rendered (2026-10-24,
  // explicit instruction: no N calls to MDM on page load, check the
  // seller's own catalog directly instead). Drives both the Price &
  // Inventory button color (inSellerCatalog) and the Published column's
  // real offer state — fully resolved server-side now (2026-10-24,
  // explicit instruction): offerState already IS the final answer
  // (not_submitted/processing/pending/rejected/approved/published), no
  // longer combined with the separate liveStatus check on the frontend.
  // That combination used to race this effect against the liveStatus one
  // (two independent, uncoordinated checks), which is exactly what made
  // the label flip between "published" and "approved" on refresh —
  // eliminated by making this one server call the single source of
  // truth, checking Offer Manager first every time (see
  // getSellerCatalogStatus's own note on why).
  useEffect(() => {
    let cancelled = false
    const toCheck = products.filter(p => p.sku && catalogStatus[p.sku] === undefined)
    if (toCheck.length === 0) return

    ;(async () => {
      for (const p of toCheck) {
        if (cancelled) return
        setCatalogStatus(s => ({ ...s, [p.sku]: 'loading' }))
        try {
          const params = new URLSearchParams({ mdmSku: p.sku })
          if (p.vtex?.vtex_product_id) params.set('marketplaceProductId', String(p.vtex.vtex_product_id))
          if (p.vtex?.vtex_sku_id) params.set('marketplaceSkuId', String(p.vtex.vtex_sku_id))
          const res = await fetch(`${BASE}/products/seller-catalog-status?${params.toString()}`)
          const data = await parseResponse(res)
          if (cancelled) return
          setCatalogStatus(s => ({
            ...s,
            [p.sku]: data.success
              ? { inSellerCatalog: !!data.inSellerCatalog, offerState: data.offerState ?? 'not_submitted' }
              : 'error',
          }))
        } catch {
          if (!cancelled) setCatalogStatus(s => ({ ...s, [p.sku]: 'error' }))
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
          <span data-tour="import"><Button variation="secondary" onClick={() => setShowImport(true)}>+ Import products</Button></span>
          <span data-tour="add-product">
            <Button variation="primary" onClick={handleAddClick} isLoading={addLoading}>
              + Add product
            </Button>
          </span>
          <button
            onClick={() => setTourStep(0)}
            title="Start guided tour"
            style={{
              width: 40, height: 40, flexShrink: 0, borderRadius: '50%', border: 'none',
              background: '#2563eb', color: '#fff', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 6px rgba(37,99,235,0.35)',
              fontSize: 16, fontWeight: 700, lineHeight: 1,
            }}
          >
            ?
          </button>
        </div>
      </div>
      {addLinkError && <div style={{ marginTop: 12 }}><Alert type="error" onClose={() => setAddLinkError(null)}>{addLinkError}</Alert></div>}
      {exportError && <div style={{ marginTop: 12 }}><Alert type="error" onClose={() => setExportError(null)}>{exportError}</Alert></div>}

      {sellerInfo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          fontSize: 12, color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0',
          borderRadius: 6, padding: '6px 6px', margin: '16px 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
          {/* App version, right-aligned — lets support confirm at a glance
              which build a seller is actually running. */}
          {sellerInfo.appVersion && (
            <span style={{ color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
              v{sellerInfo.appVersion}
            </span>
          )}
        </div>
      )}

      <div data-tour="filters" style={{
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
          <span data-tour="sort" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
          </span>
          <button
            data-tour="refresh"
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
          <div data-tour="pagination" className="seller-products-top-pagination" style={{ marginTop: -64 }}>
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

      <div style={{
        fontSize: 12, color: '#475569', background: '#eff6ff', border: '1px solid #bfdbfe',
        borderRadius: 6, padding: '8px 12px', marginBottom: 12,
      }}>
        If you've added products from "+ Add product" above or via CSV Import and they're not visible here, try refreshing the table with the ↻ button on the top right.
      </div>

      <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
        <div data-tour="columns" style={{
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
            // Real offer status — fully resolved server-side (2026-10-24,
            // explicit instruction: Offer Manager checked first, always;
            // see getSellerCatalogStatus's own note). Used directly, not
            // combined with the separate liveStatus/isPublished check
            // below (that combination is what caused the "published" vs
            // "approved" flip-flop on refresh — two uncoordinated checks
            // racing each other).
            const rowCatalogStatus = catalogStatus[p.sku]
            const catalogChecking = rowCatalogStatus === undefined || rowCatalogStatus === 'loading'
            const inSellerCatalog = typeof rowCatalogStatus === 'object' && !!rowCatalogStatus.inSellerCatalog
            const offerState = typeof rowCatalogStatus === 'object' ? rowCatalogStatus.offerState : undefined
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
            // Revert to Pending unwired entirely (2026-10-24, explicit
            // instruction: not applicable right now) — forced false rather
            // than deleting the surrounding logic/handlers, in case the
            // client wants it back later. Was:
            // !isChecking && p.status === 'active' && !isPublished
            const showRevert = false
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
                      data-tour={idx === 0 ? 'edit' : undefined}
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
                    data-tour={idx === 0 ? 'price-inventory' : undefined}
                    onClick={() => setPriceInventoryProduct(p)}
                    title={
                      inSellerCatalog
                        ? "This product already exists in your own catalog — manage its price and inventory here."
                        : "Manage this product's price and inventory. Other fields are only editable until your product is approved — after approval, you won't be able to change them."
                    }
                    style={{
                      // Inverted/filled once the product already exists in
                      // the seller's own catalog — now resolved via the
                      // live, independent catalogStatus check above
                      // (2026-10-24), not an MDM metadata read — a slightly
                      // darker green than the usual accent so white text
                      // stays readable on top of it.
                      background: inSellerCatalog ? '#15803d' : '#fff',
                      border: '1px solid #15803d', borderRadius: 4, padding: '3px 10px',
                      fontSize: 11, fontWeight: 600,
                      color: inSellerCatalog ? '#fff' : '#15803d',
                      cursor: 'pointer',
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
                  {/* Revert to Pending — unwired (2026-10-24, explicit
                      instruction: not applicable right now). showRevert is
                      forced false above, so this never renders; left in
                      place, not deleted, in case the client wants it back. */}
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
              <div data-tour={idx === 0 ? 'mdm-status' : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 2 }}>
                {/* Status modal unwired (2026-10-24, explicit instruction) —
                    not deleted, just no longer clickable. Restore by
                    swapping this back for:
                    <span onClick={() => handleStatusClick(p)} style={{ cursor: 'pointer' }} title="Click to check live MDM + marketplace status">
                */}
                <span>
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
              <div data-tour={idx === 0 ? 'published' : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 2 }}>
                {/* Live-checked per row, progressively — real offer status
                    (not_submitted/processing/pending/rejected/approved/
                    published), each with its own tooltip (2026-10-24,
                    explicit instruction). */}
                {catalogChecking ? (
                  <Tag bgColor="#e2e8f0" color="#64748b">checking…</Tag>
                ) : (
                  <span title={OFFER_STATE_DISPLAY[offerState]?.tooltip}>
                    <Tag bgColor={OFFER_STATE_DISPLAY[offerState]?.color ?? '#9E9E9E'} color="#fff">
                      {OFFER_STATE_DISPLAY[offerState]?.label ?? offerState}
                    </Tag>
                  </span>
                )}
              </div>
              <div data-tour={idx === 0 ? 'link' : undefined} style={{ fontSize: 12, color: '#666', paddingTop: 2, fontFamily: 'monospace', textAlign: 'center' }}>
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
      {/* Revert to Pending confirm modal — unwired (2026-10-24, explicit
          instruction: not applicable right now). confirmUnpublishProduct
          is never set anymore (its only setter, handleRevertClick, is
          only called from the now-dead button above), so this never
          renders; left in place, not deleted, in case the client wants
          it back. */}
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
      {/* ProductStatusModal unwired (2026-10-24, explicit instruction) —
          commented out, not deleted, so it can come back if needed:
      {statusCheckProduct && (
        <ProductStatusModal
          product={statusCheckProduct}
          loading={vtexStatusLoading}
          error={vtexStatusError}
          vtexStatus={vtexStatusData}
          onClose={() => setStatusCheckProduct(null)}
        />
      )}
      */}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { fetchParamsRef.current = { page: 1 }; doFetch() }}
        />
      )}
      <TourOverlay step={tourStep} onStepChange={setTourStep} hasProducts={products.length > 0} />
    </div>
  )
}

export default SellerProducts
