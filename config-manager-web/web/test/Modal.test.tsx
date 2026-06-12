import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../src/components/Modal.js'

describe('Modal', () => {
  it('renders title + children when open and calls onClose on Cancel', async () => {
    const onClose = vi.fn()
    render(<Modal open title="Edit budget" onClose={onClose}><p>body</p></Modal>)
    expect(screen.getByRole('dialog')).toHaveTextContent('Edit budget')
    expect(screen.getByText('body')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false} title="x" onClose={() => {}}><p>hidden</p></Modal>)
    expect(container).toBeEmptyDOMElement()
  })
})
