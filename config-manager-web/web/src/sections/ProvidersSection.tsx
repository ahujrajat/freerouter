import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Toggle } from '../components/Toggle.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

const KNOWN_PROVIDERS = ['google', 'openai', 'anthropic', 'mistral', 'groq'] as const

interface ProvidersConfig {
  providers?: Record<string, { enabled?: boolean }>
  [k: string]: unknown
}

export function ProvidersSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<ProvidersConfig>(envId)
  const [providers, setProviders] = useState<Record<string, { enabled?: boolean }>>({})
  useEffect(() => { if (cfg.data !== null) setProviders(cfg.data.providers ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>

  const toggle = (name: string, enabled: boolean) =>
    setProviders(prev => ({ ...prev, [name]: { ...prev[name], enabled } }))

  const onSave = () => {
    const base = cfg.data ?? {}
    cfg.save({ ...base, providers })   // preserve all other keys
  }

  return (
    <div className="card">
      <h2>Providers</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && (
        <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>
      )}
      {KNOWN_PROVIDERS.map(name => (
        <div key={name} className="field">
          <Toggle id={name} label={name} checked={providers[name]?.enabled === true}
            onChange={(v) => toggle(name, v)} />
        </div>
      ))}
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
