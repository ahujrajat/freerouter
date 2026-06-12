import type { EnvSummary } from '../types.js'
export function EnvSwitcher({ envs, value, onChange }: { envs: EnvSummary[]; value: string; onChange: (id: string) => void }) {
  return (
    <select aria-label="Environment" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
      {envs.map(e => <option key={e.id} value={e.id}>{e.label} ({e.role})</option>)}
    </select>
  )
}
