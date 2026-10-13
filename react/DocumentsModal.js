import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Spinner, Alert, Input, Dropdown, Button, Modal, Tag } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'

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
// Narrower than the standalone page's version (which had a whole page width
// to work with) — this has to fit inside a Modal. Actions column trimmed
// since only one of "View PDF + Delete" or "Confirm + ✕" ever shows at once.
const DOC_COLS = '70px 1fr 110px 110px 70px 80px 150px'

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

/* ── Upload modal (stacks on top of DocumentsModal) ── */
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
  const removeOrigin = (code) => setOrigins(prev => prev.filter(c => c !== code))

  const availableCountryOptions = [
    { value: '', label: 'Add origin country...' },
    ...countryOptions.filter(c => c.value && !origins.includes(c.value)),
  ]
  const countryLabel = (code) => countryOptions.find(c => c.value === code)?.label ?? code

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

      const res = await fetch(`${BASE}/documents?vtexProductId=${encodeURIComponent(product.vtexProductId)}`, {
        method: 'POST',
        body: form,
      })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Upload failed'))
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

  const handleClose = () => { handleReset(); onClose() }

  return (
    <Modal isOpen={isOpen} centered onClose={handleClose} title="Upload document">
      {/* 460/520 left an uneven gap on the right — the Modal's own rendered
          frame is wider than that, and the content div isn't auto-centered
          within it (same issue documented on RejectionReasonModal.js).
          600/700 is the width already proven not to do this elsewhere in
          this app. */}
      <div style={{ minWidth: 600, maxWidth: 700 }}>
        <div style={{
          background: '#f7f9fa', border: '1px solid #e3e4e6', borderRadius: 6,
          padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#333',
        }}>
          <strong>{product?.name}</strong>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 }}>
            PDF file (max {MAX_FILE_MB} MB)
          </label>
          <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" onChange={handleFileChange} style={{ fontSize: 13 }} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Dropdown label="Document type" placeholder="Select type..." options={DOC_TYPES} value={docType} onChange={(_, v) => setDocType(v)} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Input label="Display name (optional)" placeholder="Defaults to the file name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Input label="Grade (optional)" placeholder="e.g. Purity (GC) 99.5%" maxLength={100} value={grade} onChange={e => setGrade(e.target.value)} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Dropdown label="Origin countries (optional)" options={availableCountryOptions} value="" onChange={addOrigin} />
          {origins.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {origins.map(code => (
                <span key={code} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eff6ff',
                  border: '1px solid #93c5fd', borderRadius: 14, padding: '3px 6px 3px 10px',
                  fontSize: 12, color: '#1e40af',
                }}>
                  {countryLabel(code)}
                  <button
                    onClick={() => removeOrigin(code)}
                    style={{ background: 'none', border: 'none', color: '#1e40af', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
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
          <Button variation="primary" onClick={handleUpload} isLoading={uploading} disabled={!file || !docType}>
            Upload
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/* ── Document row ── */
const DocRow = ({ doc, idx, onDelete, deletingId }) => {
  const [confirm, setConfirm] = useState(false)
  const deleting = deletingId === doc.id

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: DOC_COLS, gap: '0 14px', padding: '14px 16px',
      borderBottom: '1px solid #eee', alignItems: 'center',
      background: idx % 2 === 0 ? '#fff' : '#fafcfe', fontSize: 12,
    }}>
      <div>
        <Tag bgColor={TYPE_COLORS[doc.type] ?? '#6b7280'} color="#fff">{(doc.type ?? '?').toUpperCase()}</Tag>
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
          <span style={{ color: '#666', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.origin_countries.map(c => c.name).join(', ')}>
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
            style={{ border: '1px solid #3f7bbf', borderRadius: 4, padding: '3px 10px', fontSize: 11, fontWeight: 600, color: '#3f7bbf', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            View PDF
          </a>
        )}
        {!confirm ? (
          <button
            onClick={() => setConfirm(true)}
            disabled={deleting}
            style={{ background: '#fff', border: '1px solid #ef4444', borderRadius: 4, padding: '3px 10px', fontSize: 11, fontWeight: 600, color: '#ef4444', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Delete
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => { setConfirm(false); onDelete(doc) }}
              disabled={deleting}
              style={{ background: '#dc2626', border: 'none', borderRadius: 4, padding: '3px 10px', fontSize: 11, fontWeight: 600, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {deleting ? '…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirm(false)}
              style={{ background: '#fff', border: '1px solid #ccc', borderRadius: 4, padding: '3px 8px', fontSize: 11, color: '#555', cursor: 'pointer' }}
            >
              ✕
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

// Replaces the old standalone "My Documents" page and its own product
// picker — opened straight from the Products table row (same spot as
// Media), so the product is already known and there's nothing to search
// for. Everything else (upload, filter, delete) is the same per-product
// documents view that page had, just product-scoped from the start.
const DocumentsModal = ({ product, onClose }) => {
  const [docs, setDocs] = useState([])
  const [loadingDocs, setLoadingDocs] = useState(true)
  const [docsError, setDocsError] = useState(null)
  const [notLinked, setNotLinked] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [nameFilter, setNameFilter] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [countryOptions, setCountryOptions] = useState([])

  const vtexProductId = product.vtex?.vtex_product_id ? String(product.vtex.vtex_product_id) : null

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

  const loadDocs = useCallback(async () => {
    if (!vtexProductId) { setNotLinked(true); setLoadingDocs(false); return }
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
  }, [vtexProductId])

  useEffect(() => { loadDocs() }, [loadDocs])

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
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? 'Delete failed'))
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

  return (
    <>
      <Modal isOpen centered onClose={onClose} title="Product documents">
        <div style={{ minWidth: 650, maxWidth: 820 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#142032' }}>{product.name}</div>
              <div style={{ fontSize: 11, color: '#666' }}>SKU: {product.sku}</div>
            </div>
            <Button variation="primary" size="small" onClick={() => setShowUpload(true)} disabled={notLinked}>
              + Upload document
            </Button>
          </div>

          {!notLinked && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <Dropdown label="Document Type" options={TYPE_FILTER_OPTIONS} value={typeFilter} onChange={(_, v) => setTypeFilter(v)} />
              <Input label="Search" placeholder="Filter by document name..." value={nameFilter} onChange={e => setNameFilter(e.target.value)} />
            </div>
          )}

          {docsError && <div style={{ marginBottom: 12 }}><Alert type="error">{docsError}</Alert></div>}
          {actionError && <div style={{ marginBottom: 12 }}><Alert type="error">{actionError}</Alert></div>}
          {notLinked && (
            <div style={{ marginBottom: 12 }}>
              <Alert type="warning">
                This product is not available for documents. Please contact the marketplace administrator.
              </Alert>
            </div>
          )}

          {loadingDocs ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          ) : !notLinked && (
            <div style={{ border: '1px solid #e0e4e8', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: DOC_COLS, gap: '0 14px', padding: '10px 16px',
                background: '#f0f4f8', borderBottom: '2px solid #dce4ec', fontSize: 11, fontWeight: 700,
                color: '#6b7c93', letterSpacing: '0.6px', textTransform: 'uppercase',
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
                  {docs.length === 0 ? 'No documents uploaded for this product yet.' : 'No documents match your filters.'}
                </div>
              ) : (
                filteredDocs.map((doc, idx) => (
                  <DocRow key={doc.id} doc={doc} idx={idx} onDelete={handleDelete} deletingId={deletingId} />
                ))
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
            <Button variation="tertiary" onClick={onClose}>Close</Button>
          </div>
        </div>
      </Modal>

      <UploadDocumentModal
        product={{ name: product.name, vtexProductId }}
        countryOptions={countryOptions}
        isOpen={showUpload}
        onClose={() => setShowUpload(false)}
        onUploaded={() => { setShowUpload(false); loadDocs() }}
      />
    </>
  )
}

export default DocumentsModal
