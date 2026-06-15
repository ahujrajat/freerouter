import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { useRowSelection } from '../app/useRowSelection.js'
import { nextId } from '../app/ids.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

type Action =
  | { type: 'pin'; model: string }
  | { type: 'strategy'; strategy: string; candidateModels?: string[] }
  | { type: 'block'; reason: string }
interface Rule { id: string; priority?: number; match: { modelPattern?: string }; action: Action }

const blank = (): Rule => ({ id: '', match: {}, action: { type: 'pin', model: '' } })
const actionSummary = (a: Action): string =>
  a.type === 'pin' ? `pin → ${a.model}` : a.type === 'block' ? `block (${a.reason})` : `strategy ${a.strategy}`

export function RulesSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const rules = useConfig<Rule[]>(envId, 'rules')
  const [list, setList] = useState<Rule[]>([])
  const [editing, setEditing] = useState<{ index: number; draft: Rule } | null>(null)
  const sel = useRowSelection<string>()
  useEffect(() => { if (rules.data !== null) setList(rules.data) }, [rules.data])

  if (rules.loading) return <div className="card">Loading…</div>

  const commit = (next: Rule[]) => { setList(next); rules.save(next) }
  const onConfirm = () => {
    if (editing === null) return
    const next = [...list]
    if (editing.index === -1) next.push({ ...editing.draft, id: nextId(list.map(r => r.id), 'rule') }); else next[editing.index] = editing.draft
    setList(next); setEditing(null)
  }

  return (
    <div className="card">
      <h2>Rules</h2>
      {rules.conflict && <ConflictBanner onReload={rules.reload} />}
      {rules.errors.length > 0 && <div className="banner banner--conflict" role="alert">{rules.errors.join('; ')}</div>}
      <Table headers={[
        <input type="checkbox" aria-label="Select all"
          checked={list.length > 0 && list.every(r => sel.isSelected(r.id))}
          onChange={(e) => sel.setMany(list.map(r => r.id), e.target.checked)} />,
        'ID', 'Model pattern', 'Action', canWrite ? 'Actions' : ''
      ]}>
        {list.map((r, i) => (
          <tr key={i}>
            <td><input type="checkbox" aria-label={`Select ${r.id}`} checked={sel.isSelected(r.id)} onChange={() => sel.toggle(r.id)} /></td>
            <td>{r.id}</td><td>{r.match.modelPattern ?? '*'}</td><td>{actionSummary(r.action)}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setEditing({ index: i, draft: r })}>Edit</Button>
                <Button variant="ghost" onClick={() => commit(list.filter((_, j) => j !== i))}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setEditing({ index: -1, draft: blank() })}>Add rule</Button>}{' '}
      {canWrite && sel.count > 0 && (
        <Button variant="ghost" onClick={() => { commit(list.filter(r => !sel.isSelected(r.id))); sel.clear() }}>Delete selected ({sel.count})</Button>
      )}{' '}
      <Button disabled={!canWrite} onClick={() => commit(list)}>Save</Button>
      <Toast message={rules.toast} />

      <Modal open={editing !== null} title={editing?.index === -1 ? 'Add rule' : 'Edit rule'} onClose={() => setEditing(null)}
        footer={<Button onClick={onConfirm}>{editing?.index === -1 ? 'Add' : 'Update'}</Button>}>
        {editing !== null && <RuleForm draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />}
      </Modal>
    </div>
  )
}

function RuleForm({ draft, onChange }: { draft: Rule; onChange: (r: Rule) => void }) {
  const setAction = (type: Action['type']) => {
    const action: Action = type === 'pin' ? { type: 'pin', model: '' } : type === 'block' ? { type: 'block', reason: '' } : { type: 'strategy', strategy: 'cheapest' }
    onChange({ ...draft, action })
  }
  return (
    <>
      <Field label="Model pattern (glob, optional)" htmlFor="r-mp">
        <TextInput id="r-mp" value={draft.match.modelPattern ?? ''} onChange={(e) => onChange({ ...draft, match: { ...draft.match, modelPattern: e.target.value || undefined } })} />
      </Field>
      <Field label="Action" htmlFor="r-act">
        <select id="r-act" value={draft.action.type} onChange={(e) => setAction(e.target.value as Action['type'])}>
          <option value="pin">pin</option><option value="strategy">strategy</option><option value="block">block</option>
        </select>
      </Field>
      {draft.action.type === 'pin' && (
        <Field label="Model to pin" htmlFor="r-model"><TextInput id="r-model" value={draft.action.model} onChange={(e) => onChange({ ...draft, action: { type: 'pin', model: e.target.value } })} /></Field>
      )}
      {draft.action.type === 'block' && (
        <Field label="Block reason" htmlFor="r-reason"><TextInput id="r-reason" value={draft.action.reason} onChange={(e) => onChange({ ...draft, action: { type: 'block', reason: e.target.value } })} /></Field>
      )}
      {draft.action.type === 'strategy' && (
        <Field label="Strategy" htmlFor="r-strat">
          <select id="r-strat" value={draft.action.strategy} onChange={(e) => onChange({ ...draft, action: { type: 'strategy', strategy: e.target.value } })}>
            <option value="cheapest">cheapest</option><option value="balanced">balanced</option><option value="performance">performance</option>
          </select>
        </Field>
      )}
    </>
  )
}
