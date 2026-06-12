import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface GeneralConfig {
  defaultProvider?: string
  defaultModel?: string
  maxInputLength?: number
  [k: string]: unknown
}

export function GeneralSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<GeneralConfig>(envId)
  const [form, setForm] = useState<GeneralConfig>({})
  useEffect(() => { if (cfg.data !== null) setForm(cfg.data) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const set = (k: keyof GeneralConfig, v: string) =>
    setForm(prev => ({ ...prev, [k]: v === '' ? undefined : v }))

  return (
    <div className="card">
      <h2>General</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && (
        <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>
      )}
      <Field label="Default provider" htmlFor="defaultProvider">
        <TextInput id="defaultProvider" value={String(form.defaultProvider ?? '')}
          disabled={!canWrite} onChange={(e) => set('defaultProvider', e.target.value)} />
      </Field>
      <Field label="Default model" htmlFor="defaultModel">
        <TextInput id="defaultModel" value={String(form.defaultModel ?? '')}
          disabled={!canWrite} onChange={(e) => set('defaultModel', e.target.value)} />
      </Field>
      <Field label="Max input length" htmlFor="maxInputLength">
        <TextInput id="maxInputLength" value={String(form.maxInputLength ?? '')}
          disabled={!canWrite} onChange={(e) => setForm(prev => ({ ...prev, maxInputLength: e.target.value === '' ? undefined : Number(e.target.value) }))} />
      </Field>
      <Button disabled={!canWrite} onClick={() => cfg.save(form)}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
