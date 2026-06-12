import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Toggle } from '../components/Toggle.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface Cfg {
  telemetryExport?: { intervalMs?: number; maxBufferSize?: number }
  promptOptimization?: { enabled?: boolean; targetModel?: string; fallbackModel?: string }
  autoOptimization?: { enabled?: boolean; targetModel?: string; candidatesPath?: string; optimizedStorePath?: string }
  [k: string]: unknown
}

export function OptimizationSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [form, setForm] = useState<Cfg>({})
  useEffect(() => { if (cfg.data !== null) setForm(cfg.data) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const po = form.promptOptimization ?? {}
  const ao = form.autoOptimization ?? {}
  const setPO = (patch: object) => setForm(prev => ({ ...prev, promptOptimization: { ...prev.promptOptimization, ...patch } }))
  const setAO = (patch: object) => setForm(prev => ({ ...prev, autoOptimization: { ...prev.autoOptimization, ...patch } }))

  return (
    <div className="card">
      <h2>Optimization</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}

      <h3>Per-request prompt optimization (GEPA)</h3>
      <div className="field"><Toggle id="po-en" label="Enable prompt optimization" checked={po.enabled === true} onChange={(v) => setPO({ enabled: v })} /></div>
      <Field label="Target (cheap) model" htmlFor="po-target"><TextInput id="po-target" value={String(po.targetModel ?? '')} disabled={!canWrite} onChange={(e) => setPO({ targetModel: e.target.value || undefined })} /></Field>
      <Field label="Fallback (capable) model" htmlFor="po-fb"><TextInput id="po-fb" value={String(po.fallbackModel ?? '')} disabled={!canWrite} onChange={(e) => setPO({ fallbackModel: e.target.value || undefined })} /></Field>

      <h3>Auto-optimization</h3>
      <div className="field"><Toggle id="ao-en" label="Enable auto-optimization" checked={ao.enabled === true} onChange={(v) => setAO({ enabled: v })} /></div>
      <Field label="Target (cheap) model" htmlFor="ao-target"><TextInput id="ao-target" value={String(ao.targetModel ?? '')} disabled={!canWrite} onChange={(e) => setAO({ targetModel: e.target.value || undefined })} /></Field>
      <Field label="Candidates file path" htmlFor="ao-cand"><TextInput id="ao-cand" value={String(ao.candidatesPath ?? '')} disabled={!canWrite} onChange={(e) => setAO({ candidatesPath: e.target.value || undefined })} /></Field>
      <Field label="Optimized store path" htmlFor="ao-opt"><TextInput id="ao-opt" value={String(ao.optimizedStorePath ?? '')} disabled={!canWrite} onChange={(e) => setAO({ optimizedStorePath: e.target.value || undefined })} /></Field>

      <Button disabled={!canWrite} onClick={() => cfg.save(form)}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
