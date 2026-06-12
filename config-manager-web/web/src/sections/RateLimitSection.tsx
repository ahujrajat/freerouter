import { useState, useEffect } from 'react'
import { useConfig } from '../app/useConfig.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { ConflictBanner } from '../components/ConflictBanner.js'

interface RateLimit { requestsPerMinute?: number; tokensPerMinute?: number; burstAllowance?: number }
interface Cfg { rateLimit?: RateLimit; [k: string]: unknown }

const numOrUndef = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s))

export function RateLimitSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const cfg = useConfig<Cfg>(envId)
  const [rl, setRl] = useState<RateLimit>({})
  useEffect(() => { if (cfg.data !== null) setRl(cfg.data.rateLimit ?? {}) }, [cfg.data])

  if (cfg.loading) return <div className="card">Loading…</div>
  const set = (k: keyof RateLimit, v: string) => setRl(prev => ({ ...prev, [k]: numOrUndef(v) }))
  const onSave = () => cfg.save({ ...(cfg.data ?? {}), rateLimit: rl })

  return (
    <div className="card">
      <h2>Rate Limit</h2>
      {cfg.conflict && <ConflictBanner onReload={cfg.reload} />}
      {cfg.errors.length > 0 && <div className="banner banner--conflict" role="alert">{cfg.errors.join('; ')}</div>}
      <Field label="Requests per minute" htmlFor="rpm">
        <TextInput id="rpm" value={String(rl.requestsPerMinute ?? '')} disabled={!canWrite} onChange={(e) => set('requestsPerMinute', e.target.value)} />
      </Field>
      <Field label="Tokens per minute" htmlFor="tpm">
        <TextInput id="tpm" value={String(rl.tokensPerMinute ?? '')} disabled={!canWrite} onChange={(e) => set('tokensPerMinute', e.target.value)} />
      </Field>
      <Field label="Burst allowance (0–1)" htmlFor="burst">
        <TextInput id="burst" value={String(rl.burstAllowance ?? '')} disabled={!canWrite} onChange={(e) => set('burstAllowance', e.target.value)} />
      </Field>
      <Button disabled={!canWrite} onClick={onSave}>Save</Button>
      <Toast message={cfg.toast} />
    </div>
  )
}
