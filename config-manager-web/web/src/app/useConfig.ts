import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api.js'
import type { VersionedDoc } from '../types.js'

export interface UseConfig<T extends object> {
  data: T | null
  version: string
  loading: boolean
  conflict: boolean
  errors: string[]
  toast: string | null
  reload: () => void
  save: (data: T) => Promise<void>
}

export function useConfig<T extends object = Record<string, unknown>>(envId: string): UseConfig<T> {
  const [data, setData] = useState<T | null>(null)
  const [version, setVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [conflict, setConflict] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true); setConflict(false); setErrors([])
    api.get<VersionedDoc<T>>(`/api/env/${envId}/config`)
      .then((doc) => { setData(doc.data); setVersion(doc.version) })
      .finally(() => setLoading(false))
  }, [envId])

  useEffect(reload, [reload])

  const save = useCallback(async (next: T) => {
    setErrors([]); setConflict(false)
    try {
      const doc = await api.put<VersionedDoc<T>>(`/api/env/${envId}/config`, { data: next, version })
      setData(doc.data); setVersion(doc.version)
      setToast('Saved'); setTimeout(() => setToast(null), 2000)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true)
      else if (e instanceof ApiError && e.status === 422) setErrors(e.messages ?? ['Invalid configuration'])
      else throw e
    }
  }, [envId, version])

  return { data, version, loading, conflict, errors, toast, reload, save }
}
