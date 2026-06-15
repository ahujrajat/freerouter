import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { useRowSelection } from '../app/useRowSelection.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

type Pair = { key: string; value: string }

export function EnvVarsSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const env = useConfig<Record<string, string>>(envId, 'env')
  const [pairs, setPairs] = useState<Pair[]>([])
  const sel = useRowSelection<number>()
  useEffect(() => { if (env.data !== null) setPairs(Object.entries(env.data).map(([key, value]) => ({ key, value }))) }, [env.data])

  if (env.loading) return <div className="card">Loading…</div>

  const onSave = () => {
    const obj: Record<string, string> = {}
    for (const p of pairs) if (p.key.trim() !== '') obj[p.key] = p.value
    env.save(obj)
  }

  const allIndices = pairs.map((_, i) => i)

  return (
    <div className="card">
      <h2>Env Vars</h2>
      {env.conflict && <ConflictBanner onReload={env.reload} />}
      {env.errors.length > 0 && <div className="banner banner--conflict" role="alert">{env.errors.join('; ')}</div>}
      {pairs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" aria-label="Select all"
            checked={pairs.length > 0 && allIndices.every(i => sel.isSelected(i))}
            onChange={(e) => sel.setMany(allIndices, e.target.checked)} />
          <span>Select all</span>
        </div>
      )}
      {pairs.map((p, i) => (
        <div key={i} className="field" style={{ display: 'flex', gap: 8 }}>
          <input type="checkbox" aria-label={`select row ${i}`} checked={sel.isSelected(i)} onChange={() => sel.toggle(i)} />
          <input aria-label={`var name ${i}`} value={p.key} disabled={!canWrite}
            onChange={(e) => setPairs(prev => prev.map((q, j) => j === i ? { ...q, key: e.target.value } : q))} />
          <input aria-label={`var value ${i}`} value={p.value} disabled={!canWrite}
            onChange={(e) => setPairs(prev => prev.map((q, j) => j === i ? { ...q, value: e.target.value } : q))} />
          {canWrite && <Button variant="ghost" onClick={() => setPairs(prev => prev.filter((_, j) => j !== i))}>Remove</Button>}
        </div>
      ))}
      {canWrite && <Button onClick={() => setPairs(prev => [...prev, { key: '', value: '' }])}>Add variable</Button>}{' '}
      {canWrite && sel.count > 0 && (
        <Button variant="ghost" onClick={() => {
          setPairs(prev => prev.filter((_, i) => !sel.isSelected(i)))
          sel.clear()
        }}>Delete selected ({sel.count})</Button>
      )}{' '}
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={env.toast} />
    </div>
  )
}
