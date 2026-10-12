import React, { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { Button } from 'vtex.styleguide'

// Ported from the marketplace admin app's react/RowActionMenu.js (same
// component, same reasoning) — consolidates per-row buttons into one
// dropdown here too, consistent with the admin table's layout. Fixed-
// position + portal-to-body so no ancestor's overflow/grid/scroll context
// can throw its position off.
const RowActionMenu = ({ label, options, buttonProps }) => {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const updateRect = () => {
      if (btnRef.current) setRect(btnRef.current.getBoundingClientRect())
    }
    updateRect()
    const handleClickOutside = e => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const handleKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', updateRect, true)
    window.addEventListener('resize', updateRect)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', updateRect, true)
      window.removeEventListener('resize', updateRect)
    }
  }, [open])

  return (
    <div ref={btnRef} style={{ display: 'inline-block' }}>
      <Button {...buttonProps} onClick={() => setOpen(o => !o)}>
        {label} <span style={{ marginLeft: 4 }}>⌄</span>
      </Button>
      {open && rect && ReactDOM.createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            minWidth: 160,
            zIndex: 2147483647,
            background: '#fff',
            border: '1px solid #d0d7de',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            padding: '2px 0',
          }}
        >
          {options.map((opt, i) => (
            <div
              key={opt.key ?? i}
              onClick={() => { setOpen(false); opt.onClick() }}
              style={{
                padding: '5px 12px',
                fontSize: 12,
                lineHeight: '18px',
                cursor: 'pointer',
                color: opt.isDangerous ? '#dc2626' : '#142032',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f7f9fa' }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff' }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

export default RowActionMenu
