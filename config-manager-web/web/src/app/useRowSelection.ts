import { useState, useCallback } from 'react'

export interface RowSelection<K> {
  selected: Set<K>
  count: number
  isSelected: (k: K) => boolean
  toggle: (k: K) => void
  setMany: (keys: K[], on: boolean) => void
  clear: () => void
}

export function useRowSelection<K = string>(): RowSelection<K> {
  const [selected, setSelected] = useState<Set<K>>(new Set())
  const isSelected = useCallback((k: K) => selected.has(k), [selected])
  const toggle = useCallback((k: K) => setSelected(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
  }), [])
  const setMany = useCallback((keys: K[], on: boolean) => setSelected(prev => {
    const n = new Set(prev); for (const k of keys) { if (on) n.add(k); else n.delete(k) } return n
  }), [])
  const clear = useCallback(() => setSelected(new Set()), [])
  return { selected, count: selected.size, isSelected, toggle, setMany, clear }
}
