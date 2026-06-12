export function Toggle({ checked, onChange, id, label }: { checked: boolean; onChange: (v: boolean) => void; id?: string; label: string }) {
  return (
    <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
      <input id={id} type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
