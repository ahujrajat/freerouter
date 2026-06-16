import { useState, useEffect, useCallback } from 'react'
import { api } from '../api.js'
import type { SpendReport, ReportBucket } from '../types.js'
import { Table } from '../components/Table.js'

const money = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}`
const num = (n: number) => n.toLocaleString()
const WINDOWS = [
  { label: 'All time', days: 0 }, { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 }, { label: 'Last 90 days', days: 90 },
]

function Breakdown({ title, label, rows }: { title: string; label: string; rows: ReportBucket[] }) {
  if (rows.length === 0) return null
  return (
    <>
      <h3>{title}</h3>
      <Table headers={[label, 'Cost', 'Requests', 'Tokens']}>
        {rows.map(r => (
          <tr key={r.key}><td>{r.key}</td><td>{money(r.costUsd)}</td><td>{num(r.requests)}</td><td>{num(r.tokens)}</td></tr>
        ))}
      </Table>
    </>
  )
}

export function ReportingSection({ envId }: { envId: string; canWrite: boolean }) {
  const [report, setReport] = useState<SpendReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(0)

  const load = useCallback(() => {
    setLoading(true)
    api.get<SpendReport>(`/api/env/${envId}/report${days > 0 ? `?days=${days}` : ''}`)
      .then(setReport).finally(() => setLoading(false))
  }, [envId, days])
  useEffect(load, [load])

  if (loading) return <div className="card">Loading…</div>
  if (report === null) return <div className="card">Failed to load report.</div>

  if (!report.configured) {
    return (
      <div className="card">
        <h2>Reporting</h2>
        <div className="banner banner--info" role="status">
          No spend data source is configured for this environment. Add a <code>spend</code> path
          (a telemetry JSONL file or a FileSpendStore JSON file the FinRouter runtime writes) to this
          environment in <code>environments.json</code> to enable reporting.
        </div>
      </div>
    )
  }

  const r = report
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, flex: 1 }}>Reporting</h2>
        <label htmlFor="rep-window" style={{ fontWeight: 600, fontSize: 13 }}>Window</label>
        <select id="rep-window" aria-label="Window" value={days} style={{ width: 'auto' }}
          onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map(w => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
      </div>

      <div className="stat-grid">
        <div className="stat"><div className="stat__label">Total spend</div><div className="stat__value">{money(r.totals.costUsd)}</div></div>
        <div className="stat"><div className="stat__label">Requests</div><div className="stat__value">{num(r.totals.requests)}</div></div>
        <div className="stat"><div className="stat__label">Tokens</div><div className="stat__value">{num(r.totals.tokens)}</div></div>
        <div className="stat"><div className="stat__label">Burn rate / day</div><div className="stat__value">{money(r.burnRateUsdPerDay)}</div></div>
        <div className="stat"><div className="stat__label">Projected / 30d</div><div className="stat__value">{money(r.projectedMonthlyUsd)}</div></div>
      </div>

      {r.totals.requests === 0 && <p>No spend records in this window yet.</p>}

      <Breakdown title="By provider" label="Provider" rows={r.byProvider} />
      <Breakdown title="By model" label="Model" rows={r.byModel} />
      <Breakdown title="By user" label="User" rows={r.byUser} />
      <Breakdown title="By team" label="Team" rows={r.byTeam} />
      <Breakdown title="By department" label="Department" rows={r.byDepartment} />
    </div>
  )
}
