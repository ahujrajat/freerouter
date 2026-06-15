import { useState, useEffect, useCallback } from 'react'
import { api } from '../api.js'
import type { CandidateRow } from '../types.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'

export function CandidatesSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>Candidates</h2>
      <p style={{ color: 'var(--text-muted)' }}>Prompts frequently run on costly models. Optimize one to generate a cheap-model template.</p>
      <Table headers={['Fingerprint', 'Model', 'Count', 'Est. savings', 'Status', canWrite ? 'Actions' : '']}>
        {rows.map(r => (
          <tr key={r.fingerprint}>
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
      <Toast message={toast} />
    </div>
  )
}
