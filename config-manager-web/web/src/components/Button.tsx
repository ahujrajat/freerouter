import type { ButtonHTMLAttributes } from 'react'
export function Button({ variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  return <button className={variant === 'ghost' ? 'btn btn--ghost' : 'btn'} {...props} />
}
