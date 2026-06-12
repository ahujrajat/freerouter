import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface Rate { input: number; output: number; cachedInput?: number }
type Overrides = Record<string, Rate>
interface Cfg { pricingOverrides?: Overrides; [k: string]: unknown }

interface DraftState {
  model: string
  inputStr: string
  outputStr: string
  cachedStr: string
}

const blankDraft = (): DraftState => ({ model: '', inputStr: '', outputStr: '', cachedStr: '' })

function draftToRate(d: DraftState): Rate {
  const input = parseFloat(d.inputStr)
  const output = parseFloat(d.outputStr)
  const cached = d.cachedStr.trim() === '' ? undefined : parseFloat(d.cachedStr)
  return {
    input: isNaN(input) ? 0 : input,
    output: isNaN(output) ? 0 : output,
    ...(cached !== undefined && !isNaN(cached) ? { cachedInput: cached } : {}),
  }
}

export function PricingSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [over, setOver] = useState<Overrides>({})
  const [draft, setDraft] = useState<DraftState | null>(null)
  useEffect(() => { if (cfg.data !== null) setOver(cfg.data.pricingOverrides ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const commit = (next: Overrides) => {
    setOver(next)
    cfg.save({ ...(cfg.data ?? {}), pricingOverrides: next })
  }

  const onConfirm = () => {
    if (draft === null || draft.model.trim() === '') return
    const rate = draftToRate(draft)
    const next = { ...over, [draft.model]: rate }
    setOver(next)
    setDraft(null)
  }

  const openEdit = (model: string, r: Rate) => {
    setDraft({
      model,
      inputStr: String(r.input),
      outputStr: String(r.output),
      cachedStr: r.cachedInput !== undefined ? String(r.cachedInput) : '',
    })
  }

  return (
    <div className="card">
      <h2>Pricing Overrides</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Table headers={['Model', 'Input $/1M', 'Output $/1M', 'Cached $/1M', canWrite ? 'Actions' : '']}>
        {Object.entries(over).map(([model, r]) => (
          <tr key={model}>
            <td>{model}</td>
            <td>{r.input}</td>
            <td>{r.output}</td>
            <td>{r.cachedInput ?? '—'}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => openEdit(model, r)}>Edit</Button>
                <Button variant="ghost" onClick={() => { const n = { ...over }; delete n[model]; commit(n) }}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setDraft(blankDraft())}>Add override</Button>}{' '}
      <Button disabled={!canWrite} onClick={() => commit(over)}>Save</Button>
      <Toast message={cfg.toast} />

      <Modal
        open={draft !== null}
        title="Pricing override"
        onClose={() => setDraft(null)}
        footer={<Button onClick={onConfirm}>Add</Button>}
      >
        {draft !== null && (
          <>
            <Field label="Model ID" htmlFor="p-model">
              <TextInput
                id="p-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </Field>
            <Field label="Input $/1M" htmlFor="p-in">
              <TextInput
                id="p-in"
                value={draft.inputStr}
                onChange={(e) => setDraft({ ...draft, inputStr: e.target.value })}
              />
            </Field>
            <Field label="Output $/1M" htmlFor="p-out">
              <TextInput
                id="p-out"
                value={draft.outputStr}
                onChange={(e) => setDraft({ ...draft, outputStr: e.target.value })}
              />
            </Field>
            <Field label="Cached input $/1M (optional)" htmlFor="p-cache">
              <TextInput
                id="p-cache"
                value={draft.cachedStr}
                onChange={(e) => setDraft({ ...draft, cachedStr: e.target.value })}
              />
            </Field>
          </>
        )}
      </Modal>
    </div>
  )
}
