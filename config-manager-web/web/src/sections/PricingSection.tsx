import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { api } from '../api.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'
import { Toggle } from '../components/Toggle.js'
import { ConflictBanner } from '../components/ConflictBanner.js'
import type { FetchedPricing } from '../types.js'

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

  const [fetchOpen, setFetchOpen] = useState(false)
  const [source, setSource] = useState('litellm')
  const [fetched, setFetched] = useState<Record<string, Rate>>({})
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const runFetch = async () => {
    const manifest = await api.get<FetchedPricing>(`/api/env/${envId}/pricing-fetch?source=${source}`)
    const flat: Record<string, Rate> = {}
    for (const models of Object.values(manifest)) for (const [model, rate] of Object.entries(models)) flat[model] = rate
    setFetched(flat); setPicked({})
  }
  const applyFetched = () => {
    setOver(prev => {
      const next = { ...prev }
      for (const [model, on] of Object.entries(picked)) if (on && fetched[model] !== undefined) next[model] = fetched[model]!
      return next
    })
    setFetchOpen(false)
  }

  const fetchedModels = Object.keys(fetched)
  const pickedCount = fetchedModels.filter((m) => picked[m] === true).length
  const allFetchedPicked = fetchedModels.length > 0 && pickedCount === fetchedModels.length

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
      {canWrite && <Button variant="ghost" onClick={() => { setFetchOpen(true); setFetched({}) }}>Fetch from source</Button>}{' '}
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

      <Modal open={fetchOpen} title="Fetch pricing" onClose={() => setFetchOpen(false)}
        footer={<Button onClick={applyFetched}>Apply selected</Button>}>
        <Field label="Source" htmlFor="pf-src">
          <select id="pf-src" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="litellm">LiteLLM</option><option value="openrouter">OpenRouter</option>
          </select>
        </Field>
        <Button onClick={runFetch}>Fetch</Button>
        {Object.keys(fetched).length > 0 && (
          <div className="fetch-toolbar">
            <Toggle
              id="pf-select-all"
              label={allFetchedPicked ? 'Deselect all' : 'Select all'}
              checked={allFetchedPicked}
              onChange={(v) => setPicked(v
                ? Object.fromEntries(Object.keys(fetched).map((m) => [m, true]))
                : {})}
            />
            <span className="fetch-toolbar__count">
              {pickedCount} of {Object.keys(fetched).length} selected
            </span>
          </div>
        )}
        <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
          {Object.keys(fetched).map((model) => (
            <div key={model} className="field">
              <Toggle id={`pf-${model}`} label={model} checked={picked[model] === true}
                onChange={(v) => setPicked(prev => ({ ...prev, [model]: v }))} />
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
