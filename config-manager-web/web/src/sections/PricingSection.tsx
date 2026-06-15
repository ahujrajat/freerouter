import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { useRowSelection } from '../app/useRowSelection.js'
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

const CSV_HEADER = 'model,input,output,cachedInput'

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Serialize pricing overrides to CSV (model,input,output,cachedInput). */
function toCsv(rows: Record<string, Rate>): string {
  const lines = [CSV_HEADER]
  for (const [model, r] of Object.entries(rows)) {
    lines.push([csvField(model), String(r.input), String(r.output), r.cachedInput ?? ''].join(','))
  }
  return lines.join('\n') + '\n'
}

function downloadCsv(filename: string, rows: Record<string, Rate>): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

/** Split one CSV line, honoring double-quoted fields (with "" escapes). */
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

/** Parse a pricing CSV into overrides. Accepts a header row (any column order
 *  among model/input/output/cachedInput) or, if absent, assumes that order.
 *  Rows missing a model or non-numeric input/output are skipped. */
function parseCsv(text: string): Record<string, Rate> {
  const out: Record<string, Rate> = {}
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) return out
  const header = splitCsvLine(lines[0]!).map(h => h.trim().toLowerCase())
  const hasHeader = header.includes('model') && header.includes('input') && header.includes('output')
  const idx = hasHeader
    ? { m: header.indexOf('model'), i: header.indexOf('input'), o: header.indexOf('output'), c: header.indexOf('cachedinput') }
    : { m: 0, i: 1, o: 2, c: 3 }
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = splitCsvLine(line)
    const model = (cells[idx.m] ?? '').trim()
    const input = parseFloat((cells[idx.i] ?? '').trim())
    const output = parseFloat((cells[idx.o] ?? '').trim())
    if (model === '' || isNaN(input) || isNaN(output)) continue
    const cachedRaw = idx.c >= 0 ? (cells[idx.c] ?? '').trim() : ''
    const cached = cachedRaw === '' ? NaN : parseFloat(cachedRaw)
    out[model] = { input, output, ...(!isNaN(cached) ? { cachedInput: cached } : {}) }
  }
  return out
}

export function PricingSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [over, setOver] = useState<Overrides>({})
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  useEffect(() => { if (cfg.data !== null) setOver(cfg.data.pricingOverrides ?? {}) }, [cfg.data])

  const sel = useRowSelection<string>()

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

  const onUploadFile = (file: File) => {
    setUploadError(null)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseCsv(reader.result as string)
        if (Object.keys(parsed).length === 0) { setUploadError('No valid rows found. Expected CSV columns: model, input, output, cachedInput.'); return }
        setOver(prev => ({ ...prev, ...parsed }))
      } catch (e) { setUploadError(`Invalid CSV: ${(e as Error).message}`) }
    }
    reader.onerror = () => { setUploadError('Failed to read file.') }
    reader.readAsText(file)
  }

  if (cfg.loading) return <div className="card">Loading…</div>

  const overKeys = Object.keys(over)
  const allSelected = overKeys.length > 0 && sel.count === overKeys.length

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

  const PRICING_TEMPLATE = { 'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 }, 'gemini-2.5-flash': { input: 0.075, output: 0.3 } }

  return (
    <div className="card">
      <h2>Pricing Overrides</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      {uploadError && <div className="banner banner--conflict" role="alert">{uploadError}</div>}
      <Table headers={[
        overKeys.length > 0
          ? <input key="sel" type="checkbox" aria-label="Select all" checked={allSelected} onChange={(e) => sel.setMany(overKeys, e.target.checked)} />
          : '',
        'Model', 'Input $/1M', 'Output $/1M', 'Cached $/1M', canWrite ? 'Actions' : ''
      ]}>
        {Object.entries(over).map(([model, r]) => (
          <tr key={model}>
            <td><input type="checkbox" aria-label={`Select ${model}`} checked={sel.isSelected(model)} onChange={() => sel.toggle(model)} /></td>
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
      <div className="actions">
        {canWrite && sel.count > 0 && (
          <Button variant="ghost" onClick={() => {
            const next = { ...over }
            for (const k of sel.selected) delete next[k]
            commit(next)
            sel.clear()
          }}>Delete selected ({sel.count})</Button>
        )}
        {canWrite && <Button onClick={() => setDraft(blankDraft())}>Add override</Button>}
        {canWrite && <Button variant="ghost" onClick={() => { setFetchOpen(true); setFetched({}) }}>Fetch from source</Button>}
        <Button variant="ghost" onClick={() => overKeys.length === 0
          ? downloadCsv('pricing-template.csv', PRICING_TEMPLATE)
          : downloadCsv('pricing-overrides.csv', over)}>
          {overKeys.length === 0 ? 'Download template (CSV)' : 'Download current (CSV)'}
        </Button>
        {canWrite && (
          <label className="btn btn--ghost" style={{ cursor: 'pointer' }}>
            Upload CSV
            <input type="file" accept="text/csv,.csv" style={{ display: 'none' }}
              aria-label="Upload pricing CSV"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadFile(f) }} />
          </label>
        )}
        <Button disabled={!canWrite} onClick={() => commit(over)}>Save</Button>
      </div>
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
