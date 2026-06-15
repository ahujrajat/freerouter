import { useState, useEffect } from 'react'
import { api } from '../api.js'
import type { AuditRow } from '../types.js'
import { Table } from '../components/Table.js'

export function AuditSection(_props: { envId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.get<AuditRow[]>('/api/audit').then(setRows).finally(() => setLoading(false)) }, [])

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>Audit</h2>
      <Table headers={['Time', 'User', 'Environment', 'Action', 'Target']}>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</td>
            <td>{r.subject}</td><td>{r.environment}</td><td>{r.action}</td><td>{r.target}</td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <p>No audit records yet.</p>}
    </div>
  )
}
