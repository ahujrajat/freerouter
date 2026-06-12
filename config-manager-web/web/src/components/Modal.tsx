import type { ReactNode } from 'react'
import { Button } from './Button.js'

export function Modal({ open, title, onClose, children, footer }: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  if (!open) return null
  return (
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">{title}</div>
        <div className="modal__body">{children}</div>
        <div className="modal__footer">
          {footer}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
