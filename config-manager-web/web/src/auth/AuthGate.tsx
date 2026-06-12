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
  if (loading) return <div className="card" style={{ margin: 16 }}>Loading…</div>
  if (me === null) return <div className="card" style={{ margin: 16 }}>Redirecting to sign in…</div>
  return <>{children(me)}</>
}
