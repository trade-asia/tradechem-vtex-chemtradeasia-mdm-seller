import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { Modal, Button, Input, Dropdown, Spinner, Alert } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'

// The media-upload step runs entirely in THIS browser tab, not on our own
// backend (2026-10-23). Uploading from our Node backend to VTEX's private
// Catalog Images endpoint consistently failed live with "Client network
// socket disconnected before secure TLS connection was established" — a
// connection dropped before any HTTP response, every single attempt, not a
// transient blip a retry could fix. That endpoint is only reliably
// reachable the way VTEX's own admin UI reaches it: a real, same-origin
// browser request (this page is already served from {account}.myvtex.com,
// same origin as that endpoint). Downloading the image bytes from MDM
// still happens server-side first (via /products/media-proxy) so the
// browser never has to fetch MDM's media host directly, which could hit a
// cross-origin (CORS) wall MDM's host was never set up to allow.
const SAVE_IMAGE_PERSISTED_HASH = 'b5ba21c6bc3fc0182305c88284ade93b9db77a770e5c3ff6ed743b9b7463ae81'

const guessImageExt = (contentType, url) => {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  const m = (url || '').match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i)
  return m ? `.${m[1].toLowerCase()}` : '.jpg'
}

// Downloads one MDM image (via our own same-origin proxy) and uploads it
// to VTEX's Catalog Images app, returning {id, url} already hosted on
// {account}.vtexassets.com — same GraphQL mutation the Seller Portal's own
// native "Add images" screen uses (captured live from its Network tab).
const uploadMediaItemInBrowser = async (item, defaultAlt) => {
  const proxyRes = await fetch(`${BASE}/products/media-proxy?url=${encodeURIComponent(item.url)}`)
  if (!proxyRes.ok) throw new Error(`Couldn't download a product image (HTTP ${proxyRes.status})`)
  const blob = await proxyRes.blob()
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${guessImageExt(blob.type, item.url)}`

  const operations = JSON.stringify({
    operationName: 'saveImage',
    variables: { filename, file: null },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: SAVE_IMAGE_PERSISTED_HASH,
        sender: 'vtex.admin-catalog@2.x',
        provider: 'vtex.catalog-images@0.x',
      },
    },
  })
  const formData = new FormData()
  formData.append('operations', operations)
  formData.append('map', JSON.stringify({ '0': ['variables.file'] }))
  formData.append('0', blob, filename)

  const uploadRes = await fetch(
    '/_v/private/graphql/v1?workspace=master&maxAge=long&appsEtag=remove&domain=admin&locale=en-US',
    { method: 'POST', body: formData }
  )
  const uploadData = await uploadRes.json().catch(() => null)
  if (uploadData?.errors?.length) throw new Error(uploadData.errors.map(e => e.message).join('; '))
  const result = uploadData?.data?.saveImage
  if (!result?.fullUrl || !result?.id) throw new Error("VTEX's image upload didn't return a usable URL")
  return { id: result.id, url: result.fullUrl, alt: item.alt || defaultAlt }
}

const parseResponse = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch {
    return { success: false, error: `Server error (HTTP ${res.status})` }
  }
}

// First save: creates the product+SKU in the seller's OWN marketplace
// catalog (Basic info/Logistics/SKU Information tabs), then sets
// price/inventory — matching the native Seller Portal "Create Product"
// form's own field set. Once linked (sellerPid/sellerSid recorded in MDM's
// metadata), those creation tabs lock and only Price/Inventory stay
// editable — re-running creation isn't meaningful once the product
// already exists.
//
// "Linked" here is entirely about sellerPid/sellerSid — this seller's own
// catalog, independent of and unrelated to p.vtex?.linked/vtex_product_id
// elsewhere in this app (whether admin has imported/linked the MDM product
// into the marketplace's own catalog). Don't conflate the two: this modal
// never reads or depends on that other link status at all.
const TABS_CREATE = ['Basic Information', 'Operations & Logistics', 'SKU Information', 'Media', 'Inventory', 'Price']
const TABS_LINKED = ['Inventory', 'Price']

// Step-chain wizard for first-time creation (2026-10-23, explicit
// instruction) — matches the marketplace admin app's own Import/Link step
// wizard: each step is independently retryable, nothing is best-effort.
// Media uploads BEFORE the product is created (confirmed live from the
// Seller Portal's own native "Add images" screen: it uploads bytes first,
// independently, then references the result by id when the product is
// actually created) — so a failed upload never leaves a half-created
// product behind, and nothing after it runs until it succeeds.
const STEP_ORDER = ['media', 'product', 'price', 'inventory', 'finalize']
const STEP_LABELS = {
  media: 'Uploading media',
  product: 'Creating product',
  price: 'Setting price',
  inventory: 'Setting inventory',
  finalize: 'Saving record',
}
const pendingSteps = () => STEP_ORDER.reduce((acc, k) => ({ ...acc, [k]: 'pending' }), {})

const StepIcon = ({ status }) => {
  if (status === 'running') return <Spinner size={16} />
  const bg = status === 'success' ? '#16a34a' : status === 'error' ? '#dc2626' : '#e2e8f0'
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: bg, color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: 1,
    }}>
      {status === 'success' ? '✓' : status === 'error' ? '✕' : ''}
    </div>
  )
}

const StepRow = ({ label, status, error, onRetry, last }) => (
  <div style={{
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '10px 0', borderBottom: last ? 'none' : '1px solid #f0f0f0',
  }}>
    <div style={{ marginTop: 1 }}><StepIcon status={status} /></div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: status === 'pending' ? '#999' : '#142032' }}>
        {label}{status === 'running' ? '…' : ''}
      </div>
      {status === 'error' && error?.message && (
        <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4, wordBreak: 'break-word' }}>
          {error.message}{error.detail ? ` — ${error.detail}` : ''}
        </div>
      )}
      {status === 'error' && onRetry && (
        <div style={{ marginTop: 6 }}>
          <Button size="small" variation="secondary" onClick={onRetry}>Retry</Button>
        </div>
      )}
    </div>
  </div>
)

const PriceInventoryModal = ({ product, onClose }) => {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveErrorDetail, setSaveErrorDetail] = useState(null)
  const [saved, setSaved] = useState(false)
  const [saveWarning, setSaveWarning] = useState(null)

  // Creation wizard — only ever used for a first-time save (see
  // STEP_ORDER/STEP_LABELS above). Once wizardActive is true, the form
  // tabs are replaced by this step list until every step succeeds.
  const [wizardActive, setWizardActive] = useState(false)
  const [steps, setSteps] = useState(pendingSteps())
  const [stepErrors, setStepErrors] = useState({})
  const [uploadedImages, setUploadedImages] = useState([])

  const [linked, setLinked] = useState(false)
  // Set once, only from the initial load — never touched by a save in this
  // session. Drives whether the "this already exists" banner shows at all:
  // `linked` alone also flips true right after a fresh creation succeeds,
  // which made that banner claim something existed before the admin had
  // even touched it (confirmed by the client: misleading on first save).
  const [wasLinkedOnLoad, setWasLinkedOnLoad] = useState(false)
  const [sellerPid, setSellerPid] = useState(null)
  const [sellerSid, setSellerSid] = useState(null)
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [brandsDebug, setBrandsDebug] = useState(null)
  const [categoriesDebug, setCategoriesDebug] = useState(null)

  // Preview only — Save is what actually attaches this media to the new
  // SKU (server re-fetches MDM media live at that point, not whatever's
  // cached here). Sync only ever refreshes this list for the seller to
  // look at before deciding to save; it never attaches anything itself.
  const [mediaItems, setMediaItems] = useState([])
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaError, setMediaError] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [editLinkLoading, setEditLinkLoading] = useState(false)
  // Confirm-before-submit (2026-10-25, explicit instruction from MDM) —
  // only ever shown for first-time creation (see handleSave): Save there
  // both creates the product and puts it into the marketplace's review
  // queue, so this is the one chance to back out and review first.
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)

  const [activeTab, setActiveTab] = useState('')

  // Basic information
  const [brandId, setBrandId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  // Operations & logistics
  const [taxCode, setTaxCode] = useState('')
  // SKU Information
  const [ean, setEan] = useState('')
  const [packageWeight, setPackageWeight] = useState('')
  const [packageWidth, setPackageWidth] = useState('')
  const [packageHeight, setPackageHeight] = useState('')
  const [packageLength, setPackageLength] = useState('')
  // Inventory
  const [warehouseId, setWarehouseId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unlimitedQuantity, setUnlimitedQuantity] = useState(false)
  // Price
  const [price, setPrice] = useState('')
  const [listPrice, setListPrice] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    // mdmSku: lets the backend fall back to a live, independent check
    // against the seller's own VTEX catalog (by RefId) when MDM has no
    // metadata record yet, instead of assuming the product was never
    // created (2026-10-24). marketplaceProductId/marketplaceSkuId: the
    // product's current marketplace link, if any — lets the backend keep
    // metadata's own copy of those two fields in sync, same instruction.
    const params = new URLSearchParams({ mdmProductId: product.id, mdmSku: product.sku })
    if (product.vtex?.vtex_product_id) params.set('marketplaceProductId', String(product.vtex.vtex_product_id))
    if (product.vtex?.vtex_sku_id) params.set('marketplaceSkuId', String(product.vtex.vtex_sku_id))
    fetch(`${BASE}/products/price-inventory?${params.toString()}`)
      .then(parseResponse)
      .then(data => {
        if (cancelled) return
        if (!data.success) { setLoadError(data.detail ? `${data.error}: ${data.detail}` : data.error); return }
        setWarehouses(data.warehouses ?? [])
        if (data.linked) {
          setLinked(true)
          setWasLinkedOnLoad(true)
          setSellerPid(data.sellerPid)
          setSellerSid(data.sellerSid)
          setActiveTab(TABS_LINKED[0])
        } else {
          setLinked(false)
          setBrands(data.brands ?? [])
          setCategories(data.categories ?? [])
          setBrandsDebug(data.brandsDebug ?? null)
          setCategoriesDebug(data.categoriesDebug ?? null)
          setActiveTab(TABS_CREATE[0])
          fetchMedia()

          // Prefill from CSV import (2026-10-24, explicit instruction):
          // brand/category are only set when the backend found a name
          // match against this seller's own live VTEX lists — an
          // unmatched name is silently skipped here rather than forced
          // into the dropdown. Everything else (EAN, dimensions, tax
          // code) comes straight from what was typed in the CSV.
          const prefill = data.importPrefill
          if (prefill) {
            if (prefill.brandId) setBrandId(String(prefill.brandId))
            if (prefill.categoryId) setCategoryId(String(prefill.categoryId))
            if (prefill.ean) setEan(String(prefill.ean))
            if (prefill.taxCode) setTaxCode(String(prefill.taxCode))
            if (prefill.packageWeight) setPackageWeight(String(prefill.packageWeight))
            if (prefill.packageWidth) setPackageWidth(String(prefill.packageWidth))
            if (prefill.packageHeight) setPackageHeight(String(prefill.packageHeight))
            if (prefill.packageLength) setPackageLength(String(prefill.packageLength))
          }
        }
        // data.price/listPrice/quantity (the linked-product path) take
        // priority; data.importPrefill's own price/quantity (2026-10-24)
        // are the fallback for a freshly-imported, not-yet-created
        // product, so the CSV's price/quantity shows up here too instead
        // of a blank form.
        setPrice(data.price ? String(data.price) : (data.importPrefill?.price ? String(data.importPrefill.price) : ''))
        setListPrice(data.listPrice ? String(data.listPrice) : (data.importPrefill?.listPrice ? String(data.importPrefill.listPrice) : ''))
        setWarehouseId(data.warehouseId || '')
        setQuantity(data.quantity ? String(data.quantity) : (data.importPrefill?.quantity ? String(data.importPrefill.quantity) : ''))
        setUnlimitedQuantity(!!data.unlimitedQuantity)
      })
      .catch(err => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product])

  // Preview-only list of MDM's current media for this product — shown in
  // the Media tab, which only exists pre-creation (see TABS_LINKED above).
  // Re-run by the Sync button to pull in anything changed via the Edit
  // link; Save independently re-fetches this live at attach time rather
  // than trusting this cached list.
  const fetchMedia = () => {
    setMediaLoading(true)
    setMediaError(null)
    fetch(`${BASE}/products/media?mdmProductId=${encodeURIComponent(product.id)}`)
      .then(parseResponse)
      .then(data => {
        if (!data.success) { setMediaError(data.detail ? `${data.error}: ${data.detail}` : data.error); return }
        setMediaItems(data.media ?? [])
      })
      .catch(err => setMediaError(err.message))
      .finally(() => setMediaLoading(false))
  }

  const handleEditClick = async () => {
    setEditLinkLoading(true)
    try {
      const res = await fetch(`${BASE}/products/edit-link?mdmProductId=${encodeURIComponent(product.id)}`, { method: 'POST' })
      const data = await parseResponse(res)
      if (!data.success) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error)
      window.open(data.url, '_blank')
    } catch (err) {
      setMediaError(err.message)
    } finally {
      setEditLinkLoading(false)
    }
  }

  const tabs = linked ? TABS_LINKED : TABS_CREATE

  const creationValid = linked || (
    !!brandId && !!categoryId &&
    Number(packageWeight) > 0 && Number(packageWidth) > 0 &&
    Number(packageHeight) > 0 && Number(packageLength) > 0
  )
  // Mandatory (2026-10-23, explicit instruction) — at least one MDM image
  // must exist before Save is even clickable. The backend independently
  // re-validates (and actually downloads) this at save time regardless;
  // this is just the client-side gate so the seller isn't let as far as a
  // failed save attempt when it's obviously going to be rejected.
  const mediaValid = linked || mediaItems.length > 0
  const inventoryValid = !!warehouseId && (unlimitedQuantity || Number(quantity) > 0)
  const priceValid = Number(price) > 0
  const canSave = creationValid && mediaValid && inventoryValid && priceValid

  const callStep = async (step, extra) => {
    try {
      const res = await fetch(`${BASE}/products/price-inventory/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, mdmProductId: product.id, ...extra }),
      })
      return await parseResponse(res)
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Runs the wizard from `fromStep` onward, in order. `carry` holds
  // sellerPid/sellerSid and the already-uploaded image list as known so
  // far — empty/null until their own steps have actually succeeded once.
  // A step failure halts the chain right there: its StepRow shows Retry,
  // and retrying calls this again starting from that same step, carrying
  // forward whatever already succeeded (so retrying e.g. the product step
  // never re-uploads media, and retrying a later step never re-creates
  // the product).
  const runChain = async (fromStep, carry) => {
    let sellerPidLocal = carry.sellerPid
    let sellerSidLocal = carry.sellerSid
    let imagesLocal = carry.images
    const startIdx = STEP_ORDER.indexOf(fromStep)
    for (let i = startIdx; i < STEP_ORDER.length; i++) {
      const step = STEP_ORDER[i]
      setSteps(s => ({ ...s, [step]: 'running' }))
      setStepErrors(e => ({ ...e, [step]: null }))

      let data
      if (step === 'media') {
        // Runs entirely in this browser tab — see this file's own note
        // (near SAVE_IMAGE_PERSISTED_HASH) on why the upload itself can't
        // run on our backend. Re-fetches MDM's media list fresh rather
        // than trusting the (preview-only) mediaItems state.
        try {
          const mediaRes = await fetch(`${BASE}/products/media?mdmProductId=${encodeURIComponent(product.id)}`)
          const mediaData = await parseResponse(mediaRes)
          if (!mediaData.success) throw new Error(mediaData.detail ? `${mediaData.error}: ${mediaData.detail}` : mediaData.error)
          const items = mediaData.media ?? []
          if (items.length === 0) throw new Error('At least one product image is required in MDM before this product can be created.')
          // Main/featured image first — the Seller Portal API's own images
          // arrays carry no separate IsMain flag; position is all it has.
          const ordered = [...items].sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0))
          const uploadedList = []
          for (const item of ordered) {
            if (!item?.url) continue
            uploadedList.push(await uploadMediaItemInBrowser(item, product.name))
          }
          data = { success: true, images: uploadedList }
        } catch (err) {
          data = { success: false, error: err.message }
        }
        if (data.success) {
          imagesLocal = data.images
          setUploadedImages(data.images)
        }
      } else if (step === 'product') {
        data = await callStep('product', {
          sellerPid: sellerPidLocal, sellerSid: sellerSidLocal,
          name: product.name, refId: product.sku,
          brandId, categoryId, taxCode, ean,
          packageWeight, packageWidth, packageHeight, packageLength,
          images: imagesLocal,
        })
        if (data.success) {
          sellerPidLocal = data.sellerPid
          sellerSidLocal = data.sellerSid
          setSellerPid(data.sellerPid)
          setSellerSid(data.sellerSid)
        }
      } else if (step === 'price') {
        data = await callStep('price', { sellerSid: sellerSidLocal, price, listPrice })
      } else if (step === 'inventory') {
        data = await callStep('inventory', { sellerSid: sellerSidLocal, warehouseId, quantity, unlimitedQuantity })
      } else {
        data = await callStep('finalize', { sellerPid: sellerPidLocal, sellerSid: sellerSidLocal, price, listPrice, warehouseId, quantity, unlimitedQuantity })
      }

      if (!data.success) {
        setSteps(s => ({ ...s, [step]: 'error' }))
        setStepErrors(e => ({ ...e, [step]: { message: data.error, detail: data.detail } }))
        setSaving(false)
        return
      }
      setSteps(s => ({ ...s, [step]: 'success' }))
    }

    setWizardActive(false)
    setLinked(true)
    setSaved(true)
    setActiveTab(TABS_LINKED[0])
    setSaving(false)
  }

  const handleRetryStep = (step) => {
    setSaving(true)
    runChain(step, { sellerPid, sellerSid, images: uploadedImages })
  }

  const handleSave = async () => {
    setSaveError(null)
    setSaveErrorDetail(null)

    if (linked) {
      // Already exists — plain price/inventory update, no wizard needed,
      // and nothing new is being "submitted for review" here, so no
      // confirmation step applies (that only matters for first-time
      // creation below).
      setSaving(true)
      try {
        const res = await fetch(`${BASE}/products/price-inventory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mdmProductId: product.id, sellerPid, sellerSid, price, listPrice: listPrice || undefined, warehouseId, quantity, unlimitedQuantity,
            // Only meaningful once the marketplace side already has this
            // product linked — included opportunistically so the metadata
            // record gets it too (2026-10-24).
            marketplaceProductId: product.vtex?.vtex_product_id, marketplaceSkuId: product.vtex?.vtex_sku_id,
          }),
        })
        const data = await parseResponse(res)
        if (!data.success) {
          setSaveError(data.error || 'Failed to save')
          setSaveErrorDetail(data.detail || null)
          return
        }
        setSaved(true)
        setSaveWarning(data.metadataError ? `Record-keeping: ${data.metadataError}` : null)
      } catch (err) {
        setSaveError(err.message)
      } finally {
        setSaving(false)
      }
      return
    }

    // First-time creation — this is the actual submission into the
    // marketplace's review queue (2026-10-25, explicit instruction from
    // MDM) — confirm first rather than firing straight into the wizard.
    setShowSubmitConfirm(true)
  }

  const proceedWithCreateSave = () => {
    setShowSubmitConfirm(false)
    setSaving(true)
    setWizardActive(true)
    setSteps(pendingSteps())
    setStepErrors({})
    setUploadedImages([])
    runChain('media', { sellerPid: null, sellerSid: null, images: null })
  }

  return (
    <Modal isOpen centered onClose={onClose} title="Price & Inventory">
      <div style={{ minWidth: 600, maxWidth: 700 }}>
        <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, marginBottom: 2 }}>{product.name}</div>
        <div style={{ fontSize: 11, color: '#666', marginBottom: 16 }}>MDM SKU: {product.sku}</div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : loadError ? (
          <Alert type="error">{loadError}</Alert>
        ) : (
          <>
            {wasLinkedOnLoad && (
              // Custom blue, not the usual green Alert — this is just
              // informational status, not a "success"/confirmation moment,
              // and deliberately says "your catalog" rather than
              // "marketplace" so it can't be misread as "this is published
              // and live" (those are two separate, unrelated things — see
              // this file's own note on why).
              <div style={{
                marginBottom: 16, fontSize: 13, color: '#1e40af',
                background: '#eff6ff', border: '1px solid #bfdbfe',
                borderRadius: 6, padding: '10px 14px',
              }}>
                This product is already in your catalog (Product ID {sellerPid}, SKU ID {sellerSid}). Once a product is created, you can only change its price and inventory here.
              </div>
            )}
            {saved && (
              <div style={{ marginBottom: 16 }}>
                <Alert type="success" onClose={() => setSaved(false)}>
                  {wasLinkedOnLoad
                    ? 'Saved successfully.'
                    : `Product added to your catalog (Product ID ${sellerPid}, SKU ID ${sellerSid}). Once a product is created, you can only change its price and inventory here.`}
                </Alert>
              </div>
            )}
            {saveWarning && (
              <div style={{ marginBottom: 16 }}>
                <Alert type="warning" onClose={() => setSaveWarning(null)}>{saveWarning}</Alert>
              </div>
            )}
            {saveError && (
              <div style={{ marginBottom: 16 }}>
                <Alert type="error" onClose={() => { setSaveError(null); setSaveErrorDetail(null) }}>
                  {saveError}
                  {saveErrorDetail && <div style={{ marginTop: 4, fontSize: 11, wordBreak: 'break-word' }}>{saveErrorDetail}</div>}
                </Alert>
              </div>
            )}

            {wizardActive && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                  Creating this product in your catalog — each step below runs on its own, and can be retried on its own if it fails.
                </div>
                {STEP_ORDER.map((step, i) => (
                  <StepRow
                    key={step}
                    label={STEP_LABELS[step]}
                    status={steps[step]}
                    error={stepErrors[step]}
                    onRetry={steps[step] === 'error' ? () => handleRetryStep(step) : undefined}
                    last={i === STEP_ORDER.length - 1}
                  />
                ))}
                {Object.values(steps).some(s => s === 'error') && (
                  <div style={{ marginTop: 8 }}>
                    <Button size="small" variation="tertiary" onClick={() => setWizardActive(false)}>
                      ← Back to form
                    </Button>
                  </div>
                )}
              </div>
            )}

            {!wizardActive && (<>
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #eee', marginBottom: 16 }}>
              {tabs.map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '8px 12px', fontSize: 13, fontWeight: 600,
                    color: activeTab === tab ? '#134cd8' : '#71757e',
                    borderBottom: activeTab === tab ? '2px solid #134cd8' : '2px solid transparent',
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'Basic Information' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Input label="Name" value={product.name} disabled />
                <Dropdown
                  label="Brand *"
                  placeholder="Select a brand..."
                  options={brands.map(b => ({ value: b.id, label: b.name }))}
                  value={brandId}
                  onChange={(_, v) => setBrandId(v)}
                />
                {brandsDebug && (
                  <div style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 10px', wordBreak: 'break-word' }}>
                    No brands found in your marketplace account, but the marketplace returned data we couldn't parse — raw response: {brandsDebug}
                  </div>
                )}
                <Dropdown
                  label="Category *"
                  placeholder="Select a category..."
                  options={categories.map(c => ({ value: c.id, label: c.name }))}
                  value={categoryId}
                  onChange={(_, v) => setCategoryId(v)}
                />
                {categoriesDebug && (
                  <div style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 10px', wordBreak: 'break-word' }}>
                    No categories found in your marketplace account, but the marketplace returned data we couldn't parse — raw response: {categoriesDebug}
                  </div>
                )}
                <Input label="Reference code" value={product.sku} disabled />
              </div>
            )}

            {activeTab === 'Operations & Logistics' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Input label="Tax code" value={taxCode} onChange={e => setTaxCode(e.target.value)} />
              </div>
            )}

            {activeTab === 'SKU Information' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ flex: 1 }}><Input label="Reference code" value={product.sku} disabled /></div>
                  <div style={{ flex: 1 }}><Input label="EAN/UPC" value={ean} onChange={e => setEan(e.target.value)} /></div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#142032' }}>Package dimensions</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                  <Input label="Weight *" type="number" value={packageWeight} onChange={e => setPackageWeight(e.target.value)} />
                  <Input label="Width *" type="number" value={packageWidth} onChange={e => setPackageWidth(e.target.value)} />
                  <Input label="Height *" type="number" value={packageHeight} onChange={e => setPackageHeight(e.target.value)} />
                  <Input label="Length *" type="number" value={packageLength} onChange={e => setPackageLength(e.target.value)} />
                </div>
              </div>
            )}

            {activeTab === 'Media' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 12, color: '#666' }}>
                  These are the pictures currently on this product in MDM — they'll be attached to it here when you Save. This media will also be attached to the product on the marketplace once it's approved.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variation="secondary" size="small" onClick={handleEditClick} isLoading={editLinkLoading}>
                    Edit — you can change media on this product
                  </Button>
                  <Button variation="secondary" size="small" onClick={fetchMedia} isLoading={mediaLoading}>
                    Sync
                  </Button>
                </div>
                {mediaError && <Alert type="error" onClose={() => setMediaError(null)}>{mediaError}</Alert>}
                {mediaLoading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spinner /></div>
                ) : mediaItems.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '8px 10px' }}>
                    No media found on this product in MDM. At least one image is required — add one via Edit, then Sync, before you can save.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                    {mediaItems.map(m => (
                      <img
                        key={m.id}
                        src={m.url}
                        alt={m.alt ?? ''}
                        onClick={() => setLightboxUrl(m.url)}
                        style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 4, border: '1px solid #e0e4e8', cursor: 'zoom-in' }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'Inventory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Dropdown
                  label="Warehouse *"
                  placeholder="Select a warehouse..."
                  options={warehouses.map(w => ({ value: w.id, label: w.name }))}
                  value={warehouseId}
                  onChange={(_, v) => setWarehouseId(v)}
                />
                <Input
                  label="Quantity *"
                  type="number"
                  value={quantity}
                  disabled={unlimitedQuantity}
                  onChange={e => setQuantity(e.target.value)}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#142032' }}>
                  <input
                    type="checkbox"
                    checked={unlimitedQuantity}
                    onChange={e => setUnlimitedQuantity(e.target.checked)}
                  />
                  Unlimited quantity
                </label>
              </div>
            )}

            {activeTab === 'Price' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Input label="Price *" type="number" value={price} onChange={e => setPrice(e.target.value)} />
                <Input label="List price" type="number" value={listPrice} onChange={e => setListPrice(e.target.value)} />
              </div>
            )}
            </>)}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
          <Button variation="tertiary" onClick={onClose}>Close</Button>
          {!loading && !loadError && !wizardActive && (
            <Button variation="primary" onClick={handleSave} isLoading={saving} disabled={!canSave}>
              Save
            </Button>
          )}
        </div>
      </div>
      {lightboxUrl && ReactDOM.createPortal(
        // Same pattern as SellerProducts.js's own media lightbox — portaled
        // to document.body so it isn't clipped by the Modal's own
        // scrollable content container.
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
      {showSubmitConfirm && ReactDOM.createPortal(
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 420, maxWidth: '100%', boxShadow: '0 20px 50px rgba(0,0,0,0.35)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#142032', marginBottom: 10 }}>Submit for review?</div>
            <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, marginBottom: 20 }}>
              Once you save, this product will be submitted for review. You won't be able to change basic details such as name, SKU, CAS number, or HS code. Please make sure everything is correct before continuing.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button
                variation="secondary"
                onClick={() => { setShowSubmitConfirm(false); handleEditClick() }}
                isLoading={editLinkLoading}
              >
                Review once more
              </Button>
              <Button variation="primary" onClick={proceedWithCreateSave}>
                Save
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </Modal>
  )
}

export default PriceInventoryModal
