import React, { useState, useEffect } from 'react'
import { Modal, Button, Input, Dropdown, Spinner, Alert } from 'vtex.styleguide'

const BASE = '/_v/mdm-seller'

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
const TABS_CREATE = ['Basic Information', 'Operations & Logistics', 'SKU Information', 'Inventory', 'Price']
const TABS_LINKED = ['Inventory', 'Price']

const PriceInventoryModal = ({ product, onClose }) => {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveErrorDetail, setSaveErrorDetail] = useState(null)
  const [saved, setSaved] = useState(false)

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
    const params = new URLSearchParams({ mdmProductId: product.id })
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
        }
        setPrice(data.price ? String(data.price) : '')
        setListPrice(data.listPrice ? String(data.listPrice) : '')
        setWarehouseId(data.warehouseId || '')
        setQuantity(data.quantity ? String(data.quantity) : '')
        setUnlimitedQuantity(!!data.unlimitedQuantity)
      })
      .catch(err => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [product])

  const tabs = linked ? TABS_LINKED : TABS_CREATE

  const creationValid = linked || (
    !!brandId && !!categoryId &&
    Number(packageWeight) > 0 && Number(packageWidth) > 0 &&
    Number(packageHeight) > 0 && Number(packageLength) > 0
  )
  const inventoryValid = !!warehouseId && (unlimitedQuantity || Number(quantity) > 0)
  const priceValid = Number(price) > 0
  const canSave = creationValid && inventoryValid && priceValid

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    setSaveErrorDetail(null)
    try {
      const res = await fetch(`${BASE}/products/price-inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mdmProductId: product.id,
          sellerPid: linked ? sellerPid : undefined,
          sellerSid: linked ? sellerSid : undefined,
          name: product.name,
          refId: product.sku,
          brandId: brandId || undefined,
          categoryId: categoryId || undefined,
          taxCode: taxCode || undefined,
          ean: ean || undefined,
          packageWeight: packageWeight || undefined,
          packageWidth: packageWidth || undefined,
          packageHeight: packageHeight || undefined,
          packageLength: packageLength || undefined,
          price,
          listPrice: listPrice || undefined,
          warehouseId,
          quantity,
          unlimitedQuantity,
        }),
      })
      const data = await parseResponse(res)
      if (!data.success) {
        setSaveError(data.error || 'Failed to save')
        setSaveErrorDetail(data.detail || null)
        if (data.sellerPid && data.sellerSid) {
          // Creation itself succeeded, only price/inventory failed — lock
          // the form onto the linked state so a retry doesn't try to
          // create the product a second time.
          setLinked(true)
          setSellerPid(data.sellerPid)
          setSellerSid(data.sellerSid)
          setActiveTab(TABS_LINKED[0])
        }
        return
      }
      setLinked(true)
      setSellerPid(data.sellerPid)
      setSellerSid(data.sellerSid)
      setSaved(true)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
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
              <div style={{ marginBottom: 16 }}>
                <Alert type="success">
                  This product already exists in your marketplace catalog (Product ID {sellerPid}, SKU ID {sellerSid}). Only price and inventory can be changed here now.
                </Alert>
              </div>
            )}
            {saved && (
              <div style={{ marginBottom: 16 }}>
                <Alert type="success" onClose={() => setSaved(false)}>
                  {wasLinkedOnLoad
                    ? 'Saved successfully.'
                    : `Product created in your marketplace catalog (Product ID ${sellerPid}, SKU ID ${sellerSid}). From now on, only price and inventory can be changed here.`}
                </Alert>
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
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
          <Button variation="tertiary" onClick={onClose}>Close</Button>
          {!loading && !loadError && (
            <Button variation="primary" onClick={handleSave} isLoading={saving} disabled={!canSave}>
              Save
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

export default PriceInventoryModal
