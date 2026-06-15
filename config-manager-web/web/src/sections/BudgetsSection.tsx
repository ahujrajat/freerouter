import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { useRowSelection } from '../app/useRowSelection.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

const WINDOWS = ['hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'total']
const ACTIONS = ['block', 'warn', 'downgrade', 'notify', 'throttle']
const SCOPES = ['global', 'org', 'department', 'team', 'user']

interface Budget {
  id: string
  maxSpendUsd: number
  window: string
  onLimitReached: string
  scope: { type: string; orgId?: string; teamId?: string; departmentId?: string; userId?: string }
  fallbackModel?: string
}
interface Cfg { budgets?: Budget[]; [k: string]: unknown }

const blank = (): Budget => ({ id: '', maxSpendUsd: NaN, window: 'monthly', onLimitReached: 'warn', scope: { type: 'global' } })

export function BudgetsSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [editing, setEditing] = useState<{ index: number; draft: Budget } | null>(null)
  const sel = useRowSelection<string>()
  useEffect(() => { if (cfg.data !== null) setBudgets(cfg.data.budgets ?? []) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const commit = (next: Budget[]) => { setBudgets(next); cfg.save({ ...(cfg.data ?? {}), budgets: next }) }
  const onModalConfirm = () => {
    if (editing === null) return
    const next = [...budgets]
    if (editing.index === -1) next.push(editing.draft)
    else next[editing.index] = editing.draft
    setBudgets(next)
    setEditing(null)
  }

  return (
    <div className="card">
      <h2>Budgets</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Table headers={[
        <input type="checkbox" aria-label="Select all"
          checked={budgets.length > 0 && budgets.every(b => sel.isSelected(b.id))}
          onChange={(e) => sel.setMany(budgets.map(b => b.id), e.target.checked)} />,
        'ID', 'Scope', 'Window', 'Max $', 'On limit', canWrite ? 'Actions' : ''
      ]}>
        {budgets.map((b, i) => (
          <tr key={i}>
            <td><input type="checkbox" aria-label={`Select ${b.id}`} checked={sel.isSelected(b.id)} onChange={() => sel.toggle(b.id)} /></td>
            <td>{b.id}</td><td>{b.scope.type}</td><td>{b.window}</td><td>{b.maxSpendUsd}</td><td>{b.onLimitReached}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setEditing({ index: i, draft: b })}>Edit</Button>
                <Button variant="ghost" onClick={() => commit(budgets.filter((_, j) => j !== i))}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setEditing({ index: -1, draft: blank() })}>Add budget</Button>}{' '}
      {canWrite && sel.count > 0 && (
        <Button variant="ghost" onClick={() => { commit(budgets.filter(b => !sel.isSelected(b.id))); sel.clear() }}>Delete selected ({sel.count})</Button>
      )}{' '}
      <Button disabled={!canWrite} onClick={() => commit(budgets)}>Save</Button>
      <Toast message={cfg.toast} />

      <Modal open={editing !== null} title={editing?.index === -1 ? 'Add budget' : 'Edit budget'} onClose={() => setEditing(null)}
        footer={<Button onClick={onModalConfirm}>{editing?.index === -1 ? 'Add' : 'Update'}</Button>}>
        {editing !== null && (
          <BudgetForm draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />
        )}
      </Modal>
    </div>
  )
}

function BudgetForm({ draft, onChange }: { draft: Budget; onChange: (d: Budget) => void }) {
  const [maxStr, setMaxStr] = useState(() => (isNaN(draft.maxSpendUsd) ? '' : String(draft.maxSpendUsd)))
  const set = (patch: Partial<Budget>) => onChange({ ...draft, ...patch })
  const onMaxChange = (raw: string) => {
    setMaxStr(raw)
    const n = parseFloat(raw)
    if (!isNaN(n)) onChange({ ...draft, maxSpendUsd: n })
  }
  return (
    <>
      <Field label="ID" htmlFor="b-id"><TextInput id="b-id" value={draft.id} onChange={(e) => set({ id: e.target.value })} /></Field>
      <Field label="Max spend (USD)" htmlFor="b-max"><TextInput id="b-max" value={maxStr} onChange={(e) => onMaxChange(e.target.value)} /></Field>
      <Field label="Window" htmlFor="b-win">
        <select id="b-win" value={draft.window} onChange={(e) => set({ window: e.target.value })}>{WINDOWS.map(w => <option key={w} value={w}>{w}</option>)}</select>
      </Field>
      <Field label="On limit reached" htmlFor="b-act">
        <select id="b-act" value={draft.onLimitReached} onChange={(e) => set({ onLimitReached: e.target.value })}>{ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}</select>
      </Field>
      <Field label="Scope type" htmlFor="b-scope">
        <select id="b-scope" value={draft.scope.type} onChange={(e) => set({ scope: { ...draft.scope, type: e.target.value } })}>{SCOPES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      </Field>
      {draft.onLimitReached === 'downgrade' && (
        <Field label="Fallback model" htmlFor="b-fb"><TextInput id="b-fb" value={draft.fallbackModel ?? ''} onChange={(e) => set({ fallbackModel: e.target.value })} /></Field>
      )}
    </>
  )
}
