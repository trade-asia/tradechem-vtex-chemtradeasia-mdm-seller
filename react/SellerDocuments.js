import React, { useState, useEffect, useCallback, useRef } from 'react'
import { PageHeader, Spinner, Alert, Input, Dropdown, Button, Modal, Tag, Pagination } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'
const PICKER_PER_PAGE = 20

const DOC_TYPES = [
  { value: 'sds', label: 'SDS — Safety Data Sheet' },
  { value: 'tds', label: 'TDS — Technical Data Sheet' },
  { value: 'msds', label: 'MSDS — Material Safety Data Sheet' },
  { value: 'other', label: 'Other' },
]

const TYPE_FILTER_OPTIONS = [{ value: '', label: 'All Types' }, ...DOC_TYPES]

const TYPE_COLORS = {
  sds: '#3b82f6',
  tds: '#8b5cf6',
  coa: '#059669',
  msds: '#f59e0b',
  other: '#6b7280',
}

const MAX_FILE_MB = 20

const PICKER_COLS = '1fr 140px 140px 120px'
const DOC_COLS = '80px 1fr 140px 140px 80px 90px 180px'

const parseResponse = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    return { success: false, error: `Server error (HTTP ${res.status})` }
  }
}

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (iso) => {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleDateString() } catch { return '-' }
}

// The MDM products feed must expose the linked VTEX product id — probe the
// shapes the backend may use.
const vtexIdOf = (product) =>
  product.vtex?.vtex_product_id ??
  product.vtex_product_id ??
  product.vtex_link?.vtex_product_id ??
  product.vtex_product_links?.[0]?.vtex_product_id ??
  null

/* ── Upload modal ── */
const UploadDocumentModal = ({ product, isOpen, onClose, onUploaded, countryOptions }) => {
  const [file, setFile] = useState(null)
  const [docType, setDocType] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [grade, setGrade] = useState('')
  const [origins, setOrigins] = useState([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)

  const addOrigin = (_, code) => {
    if (code && !origins.includes(code)) setOrigins(prev => [...prev, code])
  }

  const removeOrigin = (code) => {
    setOrigins(prev => prev.filter(c => c !== code))
  }

  const availableCountryOptions = [
    { value: '', label: 'Add origin country...' },
    ...countryOptions.filter(c => c.value && !origins.includes(c.value)),
  ]

  const countryLabel = (code) =>
    countryOptions.find(c => c.value === code)?.label ?? code

  const handleFileChange = (e) => {
    setError(null)
    const f = e.target.files?.[0] ?? null
    if (!f) { setFile(null); return }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are allowed.')
      setFile(null)
      e.target.value = ''
      return
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`File is too large (max ${MAX_FILE_MB} MB).`)
      setFile(null)
      e.target.value = ''
      return
    }
    setFile(f)
  }

  const handleUpload = async () => {
    if (!file || !docType) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('type', docType)
      if (displayName.trim()) form.append('display_name', displayName.trim())
      if (grade.trim()) form.append('grade', grade.trim())
      origins.forEach(code => form.append('origin_countries[]', code))
      // vtex_seller_id is injected server-side — never sent from the browser

      const res = await fetch(`${BASE}/documents?vtexProductId=${encodeURIComponent(product.vtexProductId)}`, {
        method: 'POST',
        body: form,
      })
      const data = await parseResponse(res)
      if (!data.success) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Upload failed'))
      }
      handleReset()
      onUploaded()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setDocType('')
    setDisplayName('')
    setGrade('')
    setOrigins([])
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleClose = () => {
    handleReset()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} centered onClose={handleClose} title="Upload document">
      <div style={{ minWidth: 460, maxWidth: 520 }}>
        <div style={{
          background: '#f7f9fa',
          border: '1px solid #e3e4e6',
          borderRadius: 6,
          padding: '8px 12px',
          marginBottom: 16,
          fontSize: 12,
          color: '#333',
        }}>
          <strong>{product?.name}</strong>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 }}>
            PDF file (max {MAX_FILE_MB} MB)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            style={{ fontSize: 13 }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Dropdown
            label="Document type"
            placeholder="Select type..."
            options={DOC_TYPES}
            value={docType}
            onChange={(_, v) => setDocType(v)}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Input
            label="Display name (optional)"
            placeholder="Defaults to the file name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Input
            label="Grade (optional)"
            placeholder="e.g. Purity (GC) 99.5%"
            maxLength={100}
            value={grade}
            onChange={e => setGrade(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Dropdown
            label="Origin countries (optional)"
            options={availableCountryOptions}
            value=""
            onChange={addOrigin}
          />
          {origins.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {origins.map(code => (
                <span
                  key={code}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: '#eff6ff',
                    border: '1px solid #93c5fd',
                    borderRadius: 14,
                    padding: '3px 6px 3px 10px',
                    fontSize: 12,
                    color: '#1e40af',
                  }}
                >
                  {countryLabel(code)}
                  <button
                    onClick={() => removeOrigin(code)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#1e40af',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1,
                      padding: '0 2px',
                    }}
                    aria-label={`Remove ${countryLabel(code)}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variation="tertiary" onClick={handleClose}>Cancel</Button>
          <Button
            variation="primary"
            onClick={handleUpload}
            isLoading={uploading}
            disabled={!file || !docType}
          >
            Upload
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/* ── Document row (all documents here belong to this seller) ── */
const DocRow = ({ doc, idx, onDelete, deletingId }) => {
  const [confirm, setConfirm] = useState(false)
  const deleting = deletingId === doc.id

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: DOC_COLS,
      gap: '0 14px',
      padding: '14px 16px',
      borderBottom: '1px solid #eee',
      alignItems: 'center',
      background: idx % 2 === 0 ? '#fff' : '#fafcfe',
      fontSize: 12,
    }}>
      <div>
        <Tag bgColor={TYPE_COLORS[doc.type] ?? '#6b7280'} color="#fff">
          {(doc.type ?? '?').toUpperCase()}
        </Tag>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.display_name ?? doc.original_filename}
        </div>
        <div style={{ color: '#999', fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.original_filename}
        </div>
      </div>

      <div style={{ color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.grade ?? ''}>
        {doc.grade ?? '-'}
      </div>

      <div style={{ minWidth: 0 }}>
        {doc.origin_countries?.length ? (
          <span
            style={{ color: '#666', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={doc.origin_countries.map(c => c.name).join(', ')}
          >
            {doc.origin_countries.map(c => c.name).join(', ')}
          </span>
        ) : (
          <span style={{ color: '#ccc' }}>-</span>
        )}
      </div>

      <div style={{ color: '#666', fontFamily: 'monospace' }}>{formatSize(doc.file?.size_bytes)}</div>

      <div style={{ color: '#666' }}>{formatDate(doc.created_at)}</div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {doc.file?.url && (
          <a
            href={doc.file.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              border: '1px solid #3f7bbf',
              borderRadius: 4,
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              color: '#3f7bbf',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            View PDF
          </a>
        )}
        {!confirm ? (
          <button
            onClick={() => setConfirm(true)}
            disabled={deleting}
            style={{
              background: '#fff',
              border: '1px solid #ef4444',
              borderRadius: 4,
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              color: '#ef4444',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Delete
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => { setConfirm(false); onDelete(doc) }}
              disabled={deleting}
              style={{
                background: '#dc2626',
                border: 'none',
                borderRadius: 4,
                padding: '3px 10px',
                fontSize: 11,
                fontWeight: 600,
                color: '#fff',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {deleting ? '…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirm(false)}
              style={{
                background: '#fff',
                border: '1px solid #ccc',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                color: '#555',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

/* ── Main page ── */
const SellerDocuments = () => {
  // Product picker
  const [query, setQuery] = useState('')
  const [skuQuery, setSkuQuery] = useState('')
  const [casQuery, setCasQuery] = useState('')
  const [searching, setSearching] = useState(true)
  const [searchResults, setSearchResults] = useState([])
  const [pickerPage, setPickerPage] = useState(1)
  const [pickerTotal, setPickerTotal] = useState(0)
  const [pickerError, setPickerError] = useState(null)
  const [selected, setSelected] = useState(null) // { name, sku, vtexProductId }
  const debounceRef = useRef(null)
  const pickerParamsRef = useRef({ page: 1, name: '', sku: '', cas: '' })

  // Documents
  const [docs, setDocs] = useState([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [docsError, setDocsError] = useState(null)
  const [notLinked, setNotLinked] = useState(false)

  // Filters
  const [typeFilter, setTypeFilter] = useState('')
  const [nameFilter, setNameFilter] = useState('')

  // Upload / delete
  const [showUpload, setShowUpload] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [actionError, setActionError] = useState(null)

  // Countries for the origins multi-select
  const [countryOptions, setCountryOptions] = useState([])

  useEffect(() => {
    fetch(`${BASE}/countries`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (!json?.countries?.length) return
        setCountryOptions(
          json.countries
            .filter(c => c.code && c.name)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(c => ({ value: c.code, label: c.name }))
        )
      })
      .catch(() => {})
  }, [])

  const fetchLinkedProducts = useCallback(async () => {
    const { page, name, sku, cas } = pickerParamsRef.current
    setSearching(true)
    setPickerError(null)
    try {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(PICKER_PER_PAGE),
      })
      if (name.trim()) params.set('name', name.trim())
      if (sku.trim()) params.set('sku', sku.trim())
      if (cas.trim()) params.set('cas_number', cas.trim())
      const res = await fetch(`${BASE}/products?${params.toString()}`)
      const json = await parseResponse(res)
      if (json.success === false) throw new Error(json.detail ? `${json.error}: ${json.detail}` : json.error)
      setSearchResults(json.products ?? [])
      setPickerTotal(json.total ?? 0)
      setPickerPage(page)
    } catch (err) {
      setPickerError(err.message)
      setSearchResults([])
      setPickerTotal(0)
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => { fetchLinkedProducts() }, [fetchLinkedProducts])

  const handlePickerText = (field, setter) => (e) => {
    const val = e.target.value
    setter(val)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pickerParamsRef.current = { ...pickerParamsRef.current, page: 1, [field]: val }
      fetchLinkedProducts()
    }, 400)
  }

  const handlePickerNext = () => {
    pickerParamsRef.current = { ...pickerParamsRef.current, page: pickerParamsRef.current.page + 1 }
    fetchLinkedProducts()
  }

  const handlePickerPrev = () => {
    pickerParamsRef.current = { ...pickerParamsRef.current, page: Math.max(1, pickerParamsRef.current.page - 1) }
    fetchLinkedProducts()
  }

  const loadDocs = useCallback(async (vtexProductId) => {
    setLoadingDocs(true)
    setDocsError(null)
    setNotLinked(false)
    try {
      const res = await fetch(`${BASE}/documents?vtexProductId=${encodeURIComponent(vtexProductId)}`)
      const data = await parseResponse(res)
      if (!data.success) {
        if (data.error === 'not_linked') { setNotLinked(true); setDocs([]); return }
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Failed to load documents'))
      }
      setDocs(data.documents ?? [])
    } catch (err) {
      setDocsError(err.message)
      setDocs([])
    } finally {
      setLoadingDocs(false)
    }
  }, [])

  const handleSelectProduct = (product) => {
    const vtexProductId = vtexIdOf(product)
    if (!vtexProductId) return
    const sel = {
      name: product.name,
      sku: product.sku,
      vtexProductId: String(vtexProductId),
    }
    setSelected(sel)
    setTypeFilter('')
    setNameFilter('')
    setActionError(null)
    loadDocs(sel.vtexProductId)
  }

  const handleChangeProduct = () => {
    setSelected(null)
    setDocs([])
    setDocsError(null)
    setNotLinked(false)
    setActionError(null)
  }

  const handleDelete = async (doc) => {
    setDeletingId(doc.id)
    setActionError(null)
    try {
      const res = await fetch(`${BASE}/documents/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id }),
      })
      const data = await parseResponse(res)
      if (!data.success) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Delete failed'))
      }
      setDocs(prev => prev.filter(d => d.id !== doc.id))
    } catch (err) {
      setActionError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  const filteredDocs = docs.filter(d => {
    if (typeFilter && d.type !== typeFilter) return false
    if (nameFilter) {
      const q = nameFilter.toLowerCase()
      const hay = `${d.display_name ?? ''} ${d.original_filename ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const pickerFrom = pickerTotal === 0 ? 0 : (pickerPage - 1) * PICKER_PER_PAGE + 1
  const pickerTo = (pickerPage - 1) * PICKER_PER_PAGE + searchResults.length

  return (
    <div className="pa6">
      <PageHeader
        title="My Documents"
        subtitle="Upload and manage your SDS / TDS / MSDS documents for marketplace products"
      />

      {!selected ? (
        <>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: '#eff6ff',
            border: '1px solid #93c5fd',
            borderLeft: '4px solid #3b82f6',
            borderRadius: 6,
            padding: '12px 16px',
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 18 }}>ℹ️</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#1e40af' }}>
                Select a product to manage its documents
              </div>
              <div style={{ fontSize: 12, color: '#1e3a8a' }}>
                You will only see documents you uploaded. Documents from the marketplace or other sellers are not visible here.
              </div>
            </div>
          </div>

          {/* ── Picker filters ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            padding: '16px 20px',
            background: '#f7f9fa',
            border: '1px solid #e3e4e6',
            borderRadius: 8,
            marginBottom: 16,
          }}>
            <Input label="Product Name" placeholder="Search name..." value={query} onChange={handlePickerText('name', setQuery)} />
            <Input label="SKU" placeholder="e.g. PRD-GRGNC-80500907" value={skuQuery} onChange={handlePickerText('sku', setSkuQuery)} />
            <Input label="CAS Number" placeholder="e.g. 8050-09-07" value={casQuery} onChange={handlePickerText('cas', setCasQuery)} />
          </div>

          {pickerError && <div style={{ marginBottom: 12 }}><Alert type="error">{pickerError}</Alert></div>}

          {(searching || pickerTotal > 0) && (
            <div className="mb3">
              <Pagination
                currentItemFrom={pickerFrom}
                currentItemTo={pickerTo}
                textOf="of"
                totalItems={pickerTotal}
                onNextClick={handlePickerNext}
                onPrevClick={handlePickerPrev}
              />
            </div>
          )}

          {/* ── Picker table ── */}
          <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: PICKER_COLS,
              gap: '0 16px',
              padding: '10px 16px',
              background: '#f0f4f8',
              borderBottom: '2px solid #dce4ec',
              fontSize: 11,
              fontWeight: 700,
              color: '#6b7c93',
              letterSpacing: '0.6px',
              textTransform: 'uppercase',
            }}>
              <div>Product</div>
              <div>SKU</div>
              <div>CAS</div>
              <div />
            </div>

            {searching ? (
              <div className="flex justify-center pv8"><Spinner /></div>
            ) : searchResults.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: '#999', fontSize: 14 }}>
                No products found.
              </div>
            ) : (
              searchResults.map((product, idx) => {
                const vtexProductId = vtexIdOf(product)
                return (
                  <div
                    key={product.id ?? idx}
                    onClick={() => vtexProductId && handleSelectProduct(product)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: PICKER_COLS,
                      gap: '0 16px',
                      padding: '14px 16px',
                      borderBottom: '1px solid #eee',
                      alignItems: 'center',
                      background: idx % 2 === 0 ? '#fff' : '#fafcfe',
                      cursor: vtexProductId ? 'pointer' : 'not-allowed',
                      opacity: vtexProductId ? 1 : 0.5,
                    }}
                    onMouseEnter={e => { if (vtexProductId) e.currentTarget.style.background = '#f0f7ff' }}
                    onMouseLeave={e => { e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#fafcfe' }}
                  >
                    <div style={{ fontWeight: 600, color: '#142032', fontSize: 13 }}>{product.name}</div>
                    <div style={{ fontSize: 11, color: '#666', fontFamily: 'monospace' }}>{product.sku ?? '-'}</div>
                    <div style={{ fontSize: 11, color: '#666', fontFamily: 'monospace' }}>{product.cas_number ?? '-'}</div>
                    <div>
                      {vtexProductId ? (
                        <span style={{
                          border: '1px solid #3f7bbf',
                          borderRadius: 4,
                          padding: '4px 12px',
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#3f7bbf',
                          whiteSpace: 'nowrap',
                        }}>
                          Documents →
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#999' }}>not available</span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </>
      ) : (
        <>
          {/* ── Selected product bar ── */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 16,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#142032' }}>{selected.name}</div>
              <div style={{ fontSize: 11, color: '#666' }}>SKU: {selected.sku}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variation="secondary" size="small" onClick={handleChangeProduct}>
                ← All products
              </Button>
              <Button variation="primary" size="small" onClick={() => setShowUpload(true)} disabled={notLinked}>
                + Upload document
              </Button>
            </div>
          </div>

          {/* ── Document filters ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            padding: '16px 20px',
            background: '#f7f9fa',
            border: '1px solid #e3e4e6',
            borderRadius: 8,
            marginBottom: 16,
          }}>
            <Dropdown
              label="Document Type"
              options={TYPE_FILTER_OPTIONS}
              value={typeFilter}
              onChange={(_, v) => setTypeFilter(v)}
            />
            <Input
              label="Search"
              placeholder="Filter by document name..."
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
            />
            <div />
          </div>

          {docsError && <div style={{ marginBottom: 12 }}><Alert type="error">{docsError}</Alert></div>}
          {actionError && <div style={{ marginBottom: 12 }}><Alert type="error">{actionError}</Alert></div>}
          {notLinked && (
            <div style={{ marginBottom: 12 }}>
              <Alert type="warning">
                This product is not available for documents. Please contact the marketplace administrator.
              </Alert>
            </div>
          )}

          {/* ── Documents table ── */}
          {loadingDocs ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          ) : !notLinked && (
            <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: DOC_COLS,
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
                <div>Type</div>
                <div>Document</div>
                <div>Grade</div>
                <div>Origins</div>
                <div>Size</div>
                <div>Date</div>
                <div style={{ textAlign: 'right' }}>Actions</div>
              </div>

              {filteredDocs.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#999', fontSize: 13 }}>
                  {docs.length === 0
                    ? 'You have not uploaded any documents for this product yet.'
                    : 'No documents match your filters.'}
                </div>
              ) : (
                filteredDocs.map((doc, idx) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    idx={idx}
                    onDelete={handleDelete}
                    deletingId={deletingId}
                  />
                ))
              )}
            </div>
          )}

          <UploadDocumentModal
            product={selected}
            countryOptions={countryOptions}
            isOpen={showUpload}
            onClose={() => setShowUpload(false)}
            onUploaded={() => {
              setShowUpload(false)
              loadDocs(selected.vtexProductId)
            }}
          />
        </>
      )}
    </div>
  )
}

export default SellerDocuments
