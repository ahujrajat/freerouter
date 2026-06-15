import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api.js'
import type { MeResponse } from '../types.js'

export function AuthGate({ children }: { children: (me: MeResponse) => ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api.get<MeResponse>('/auth/me')
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) window.location.href = '/auth/login' })
      .finally(() => setLoading(false))
  }, [])
  if (loading) {
    return (
      <div className="screen">
        <div className="screen__card">
          <div className="screen__brand"><span className="brand-mark" aria-hidden="true">&gt;</span> FreeRouter</div>
          <div className="spinner" role="status" aria-label="Loading" />
          <div className="screen__muted">Loading your configuration…</div>
        </div>
      </div>
    )
  }
  if (me === null) {
    return (
      <div className="screen">
        <div className="screen__card">
          <div className="screen__brand"><span className="brand-mark" aria-hidden="true">&gt;</span> FreeRouter</div>
          <div className="screen__muted">Redirecting to sign in…</div>
        </div>
      </div>
    )
  }
  return <>{children(me)}</>
}
