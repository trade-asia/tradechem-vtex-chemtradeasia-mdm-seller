import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom'
import { Spinner, Alert, Input, Dropdown, Button, Modal, Tag, Pagination } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'
const PER_PAGE = 20
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
  { value: '1', label: 'Linked to VTEX' },
  { value: '0', label: 'Not Linked' },
]

const STATUS_COLORS = {
  active: '#8BC34A',
  draft: '#FFB300',
  archived: '#9E9E9E',
  pending: '#3b82f6',
  pending_approval: '#3b82f6',
  rejected: '#dc2626',
}

const COLS = '1fr 120px 100px 110px 100px'

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
  // Set once the pre-flight check finds SKUs already active — holds what's
  // needed to either re-upload as-is or rebuild the CSV with those rows
  // dropped, without re-parsing the file a second time.
  const [conflict, setConflict] = useState(null) // { activeSkus: [{sku,name}], rows, skuColIndex }

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
  // stops to warn before touching anything that's already active — updating
  // an active SKU reverts it to pending in both MDM and VTEX, delisting it
  // from the storefront, which is not something to do without asking first.
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

      const skus = [...new Set(rows.slice(1).map(r => (r[skuColIndex] ?? '').trim()).filter(Boolean))]
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
      const activeSkus = lookups
        .filter(p => p && p.status === 'active')
        .map(p => ({ sku: p.sku, name: p.name }))

      if (activeSkus.length) {
        setConflict({ activeSkus, rows, skuColIndex })
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
    const { activeSkus, rows, skuColIndex } = conflict
    const skipSet = new Set(activeSkus.map(s => s.sku))
    const filteredRows = [rows[0], ...rows.slice(1).filter(r => !skipSet.has((r[skuColIndex] ?? '').trim()))]
    const csvText = serializeCsv(filteredRows)
    const filteredFile = new File([csvText], file.name, { type: file.type || 'text/csv' })
    setConflict(null)
    if (filteredRows.length <= 1) {
      setError('Nothing left to import — every row in the file was already active.')
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

        {conflict ? (
          <div style={{
            fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a',
            borderRadius: 6, padding: '12px 14px', marginBottom: 16,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              {conflict.activeSkus.length} SKU{conflict.activeSkus.length > 1 ? 's are' : ' is'} already active
            </div>
            <div style={{ marginBottom: 8 }}>
              Updating {conflict.activeSkus.length > 1 ? 'them' : 'it'} will revert the status back to Pending
              Approval in both MDM and VTEX, and the product will be delisted from VTEX until it's re-approved.
            </div>
            <div style={{ marginBottom: 10, maxHeight: 120, overflowY: 'auto' }}>
              {conflict.activeSkus.map(s => (
                <div key={s.sku} style={{ fontFamily: 'monospace' }}>{s.sku} — {s.name}</div>
              ))}
            </div>
            <div>Proceed and update everyone anyway, or skip just these SKUs and import the rest?</div>
          </div>
        ) : !result && (
          <div style={{ marginBottom: 12 }}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
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

const SellerProducts = () => {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const [nameFilter, setNameFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [casFilter, setCasFilter] = useState('')
  const [hsFilter, setHsFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [linkedFilter, setLinkedFilter] = useState('')

  const [mediaProduct, setMediaProduct] = useState(null)
  const [showImport, setShowImport] = useState(false)

  const fetchParamsRef = useRef({ page: 1 })
  const debounceRef = useRef(null)

  useEffect(() => { fetch(`${BASE}/touch-login`).catch(() => {}) }, [])

  const doFetch = useCallback(async () => {
    const p = fetchParamsRef.current.page
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p), per_page: String(PER_PAGE) })
      if (nameFilter) params.set('name', nameFilter)
      if (skuFilter) params.set('sku', skuFilter)
      if (casFilter) params.set('cas_number', casFilter)
      if (hsFilter) params.set('hs_code', hsFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (linkedFilter) params.set('vtex_linked', linkedFilter)

      const res = await fetch(`${BASE}/products-list?${params.toString()}`)
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      setProducts(data.products ?? [])
      setTotal(data.total ?? 0)
      setPage(p)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameFilter, skuFilter, casFilter, hsFilter, statusFilter, linkedFilter])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchParamsRef.current = { page: 1 }
      doFetch()
    }, DEBOUNCE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameFilter, skuFilter, casFilter, hsFilter, statusFilter, linkedFilter])

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

  const totalFrom = total === 0 ? 0 : (page - 1) * PER_PAGE + 1
  const totalTo = Math.min(page * PER_PAGE, total)

  return (
    <div className="pa6">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#142032', marginBottom: 4 }}>My Products</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 24 }}>Your products, synced with MDM.</div>
        </div>
        <Button variation="primary" onClick={() => setShowImport(true)}>+ Import products</Button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}>
        <Input label="Product Name" placeholder="Search name..." value={nameFilter} onChange={e => setNameFilter(e.target.value)} />
        <Input label="SKU" placeholder="Search SKU..." value={skuFilter} onChange={e => setSkuFilter(e.target.value)} />
        <Input label="CAS Number" placeholder="e.g. 8050-09-07" value={casFilter} onChange={e => setCasFilter(e.target.value)} />
        <Input label="HS Code" placeholder="e.g. 3806.10.00" value={hsFilter} onChange={e => setHsFilter(e.target.value)} />
        <Dropdown label="Status" options={STATUS_OPTIONS} value={statusFilter} onChange={(_, v) => setStatusFilter(v)} />
        <Dropdown label="VTEX Link" options={VTEX_LINKED_OPTIONS} value={linkedFilter} onChange={(_, v) => setLinkedFilter(v)} />
      </div>

      {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}

      <div className="mb3" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
        <button
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh with current filters"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 32,
            boxSizing: 'border-box',
            background: 'none',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '0 12px',
            fontSize: 12,
            lineHeight: 1,
            cursor: loading ? 'default' : 'pointer',
            color: '#555',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
        <Pagination
          currentItemFrom={totalFrom}
          currentItemTo={totalTo}
          textOf="of"
          totalItems={total}
          onNextClick={handleNextPage}
          onPrevClick={handlePrevPage}
        />
      </div>

      <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', padding: '10px 16px',
          background: '#f0f4f8', borderBottom: '2px solid #dce4ec', fontSize: 11, fontWeight: 700,
          color: '#6b7c93', letterSpacing: '0.6px', textTransform: 'uppercase',
        }}>
          <div>Product</div>
          <div>SKU</div>
          <div>Status</div>
          <div>VTEX Link</div>
          <div>Actions</div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : products.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#999', fontSize: 14 }}>
            No products match your filters.
          </div>
        ) : (
          products.map((p, idx) => (
            <div
              key={p.id ?? idx}
              style={{
                display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', padding: '12px 16px',
                borderBottom: '1px solid #eee', alignItems: 'center',
                background: idx % 2 === 0 ? '#fff' : '#fafcfe',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, color: '#142032' }}>{p.name}</div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#444' }}>{p.sku}</div>
              <div>
                <Tag bgColor={STATUS_COLORS[p.status] ?? '#9E9E9E'} color="#fff">{p.status}</Tag>
              </div>
              <div style={{ fontSize: 12, color: '#666' }}>
                {p.vtex?.linked ? `Linked - ${p.vtex.vtex_product_id}` : 'Not linked'}
              </div>
              <div>
                <button
                  onClick={() => setMediaProduct(p)}
                  style={{
                    background: '#fff', border: '1px solid #9333ea', borderRadius: 4, padding: '3px 10px',
                    fontSize: 11, fontWeight: 600, color: '#9333ea', cursor: 'pointer',
                  }}
                >
                  Media
                </button>
              </div>
            </div>
          ))
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

      {mediaProduct && <MediaModal product={mediaProduct} onClose={() => setMediaProduct(null)} />}
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
