import React from 'react'
import { Modal, Button, Tag, Spinner, Alert } from 'vtex.styleguide'

// Side-by-side MDM status vs. the *live* VTEX status — opened from clicking
// the Status tag, or from inside the Revert to Pending confirm. MDM's own
// status field only tells half the story: a product can show Pending in MDM
// while the linked VTEX SKU is still Active and live on the storefront (the
// exact gap this session's VTEX-deactivation work is closing) — this gives
// the seller a direct, current read of both instead of assuming they match.
const ProductStatusModal = ({ product, loading, error, vtexStatus, onClose }) => (
  <Modal isOpen centered onClose={onClose} title="Product status">
    <div style={{ minWidth: 520, maxWidth: 620 }}>
      <div style={{ fontWeight: 600, color: '#142032', fontSize: 13, marginBottom: 16 }}>
        {product?.name}
      </div>

      <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7c93', textTransform: 'uppercase', marginBottom: 6 }}>
            MDM status
          </div>
          <Tag bgColor={product?.status === 'active' ? '#8BC34A' : product?.status === 'rejected' ? '#dc2626' : '#3b82f6'} color="#fff">
            {product?.status}
          </Tag>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7c93', textTransform: 'uppercase', marginBottom: 6 }}>
            VTEX status
          </div>
          {loading ? (
            <Spinner size={24} />
          ) : !product?.vtex?.vtex_product_id ? (
            <Tag bgColor="#9E9E9E" color="#fff">Not linked</Tag>
          ) : error ? (
            <span style={{ fontSize: 12, color: '#dc2626' }}>Couldn't check — {error}</span>
          ) : (
            <Tag bgColor={vtexStatus?.isActive ? '#8BC34A' : '#9E9E9E'} color="#fff">
              {vtexStatus?.isActive ? 'active' : 'inactive'}
            </Tag>
          )}
        </div>
      </div>

      {!loading && !error && product?.vtex?.vtex_product_id && product?.status === 'active' && !vtexStatus?.isActive && (
        <div style={{ marginBottom: 12 }}>
          <Alert type="warning">
            MDM shows this product as Active, but the linked VTEX product is Inactive — it will not appear on the storefront despite MDM's status.
          </Alert>
        </div>
      )}
      {!loading && !error && product?.vtex?.vtex_product_id && product?.status !== 'active' && vtexStatus?.isActive && (
        <div style={{ marginBottom: 12 }}>
          <Alert type="warning">
            MDM shows this product as {product?.status}, but the linked VTEX product is still Active — it may still be visible on the storefront.
          </Alert>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variation="tertiary" onClick={onClose}>Close</Button>
      </div>
    </div>
  </Modal>
)

export default ProductStatusModal
