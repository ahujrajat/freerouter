import { useState, useEffect, useCallback } from 'react'
import { api } from '../api.js'
import type { CandidateRow } from '../types.js'
import { useRowSelection } from '../app/useRowSelection.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'

export function CandidatesSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const sel = useRowSelection<string>()

  const reload = useCallback(() => {
    setLoading(true)
    api.get<CandidateRow[]>(`/api/env/${envId}/candidates`).then(setRows).finally(() => setLoading(false))
  }, [envId])
  useEffect(reload, [reload])

  const optimize = async (fingerprint: string) => {
    setBusy(fingerprint)
    try {
      await api.post(`/api/env/${envId}/candidates/${encodeURIComponent(fingerprint)}/optimize`, {})
      setToast('Optimized'); setTimeout(() => setToast(null), 2000); reload()
    } finally { setBusy(null) }
  }

  const deleteSelected = async () => {
    const fps = Array.from(sel.selected)
    for (const fp of fps) {
      await api.del(`/api/env/${envId}/candidates/${encodeURIComponent(fp)}`)
    }
    sel.clear()
    reload()
  }

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>Candidates</h2>
      <p style={{ color: 'var(--text-muted)' }}>Prompts frequently run on costly models. Optimize one to generate a cheap-model template.</p>
      <Table headers={[
        <input type="checkbox" aria-label="Select all"
          checked={rows.length > 0 && rows.every(r => sel.isSelected(r.fingerprint))}
          onChange={(e) => sel.setMany(rows.map(r => r.fingerprint), e.target.checked)} />,
        'Fingerprint', 'Model', 'Count', 'Est. savings', 'Status', canWrite ? 'Actions' : ''
      ]}>
        {rows.map(r => (
          <tr key={r.fingerprint}>
            <td><input type="checkbox" aria-label={`Select ${r.fingerprint}`} checked={sel.isSelected(r.fingerprint)} onChange={() => sel.toggle(r.fingerprint)} /></td>
            <td title={r.fingerprint}>{r.fingerprint.slice(0, 24)}{r.fingerprint.length > 24 ? '…' : ''}</td>
            <td>{r.model}</td><td>{r.count}</td><td>{`$${r.estPredictedSavingsUsd.toFixed(4)}`}</td><td>{r.status}</td>
            <td>{canWrite && r.status !== 'optimized' && (
              <Button variant="ghost" disabled={busy === r.fingerprint} onClick={() => optimize(r.fingerprint)}>
                {busy === r.fingerprint ? 'Optimizing…' : 'Optimize'}
              </Button>
            )}</td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <p>No candidates yet.</p>}
      {canWrite && sel.count > 0 && (
        <Button variant="ghost" onClick={deleteSelected}>Delete selected ({sel.count})</Button>
      )}
      <Toast message={toast} />
    </div>
  )
}
