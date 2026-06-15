export function Toggle({ checked, onChange, id, label }: { checked: boolean; onChange: (v: boolean) => void; id?: string; label: string }) {
  return (
    <label htmlFor={id} className="toggle">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
