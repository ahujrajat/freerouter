import { useState, useEffect, useCallback } from 'react'
import { api, ApiError } from '../api.js'
import type { ByokEntry } from '../types.js'
import { Field } from '../components/Field.js'
import { TextInput } from '../components/TextInput.js'
import { Button } from '../components/Button.js'
import { Toast } from '../components/Toast.js'
import { Table } from '../components/Table.js'
import { Modal } from '../components/Modal.js'

const BACKENDS = ['local', 'vault', 'aws-secrets-manager', 'azure-key-vault', 'gcp-secret-manager']

export function ByokSection({ envId, canWrite }: { envId: string; canWrite: boolean }) {
  const [entries, setEntries] = useState<ByokEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ provider: string; backend: string; secret: string; ref: string } | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.get<ByokEntry[]>(`/api/env/${envId}/byok`).then(setEntries).finally(() => setLoading(false))
  }, [envId])
  useEffect(reload, [reload])

  const onSave = async () => {
    if (draft === null || draft.provider.trim() === '') return
    setError(null)
    try {
      await api.post(`/api/env/${envId}/byok/${encodeURIComponent(draft.provider)}`, {
        backend: draft.backend,
        ...(draft.secret !== '' && { secret: draft.secret }),
        ...(draft.ref !== '' && { ref: draft.ref }),
      })
      setDraft(null); setToast('Key saved'); setTimeout(() => setToast(null), 2000); reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save key')
    }
  }

  const onDelete = async (provider: string) => {
    await api.del(`/api/env/${envId}/byok/${encodeURIComponent(provider)}`); reload()
  }

  if (loading) return <div className="card">Loading…</div>

  return (
    <div className="card">
      <h2>BYOK Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys are write-only — they are encrypted or stored in your key manager and never shown again.</p>
      {error !== null && <div className="banner banner--conflict" role="alert">{error}</div>}
      <Table headers={['Provider', 'Backend', 'Key', 'Ref', canWrite ? 'Actions' : '']}>
        {entries.map(e => (
          <tr key={e.provider}>
            <td>{e.provider}</td><td>{e.backend}</td><td>{e.last4 !== undefined ? `••••${e.last4}` : '••••'}</td><td>{e.ref ?? '—'}</td>
            <td>{canWrite && (
              <div className="row-actions">
                <Button variant="ghost" onClick={() => setDraft({ provider: e.provider, backend: e.backend, secret: '', ref: e.ref ?? '' })}>Rotate</Button>
                <Button variant="ghost" onClick={() => onDelete(e.provider)}>Delete</Button>
              </div>
            )}</td>
          </tr>
        ))}
      </Table>
      {canWrite && <Button onClick={() => setDraft({ provider: '', backend: 'local', secret: '', ref: '' })}>Set key</Button>}
      <Toast message={toast} />

      <Modal open={draft !== null} title="Set BYOK key" onClose={() => setDraft(null)}
        footer={<Button onClick={onSave}>Save key</Button>}>
        {draft !== null && (
          <>
            <Field label="Provider" htmlFor="bk-prov"><TextInput id="bk-prov" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })} /></Field>
            <Field label="Backend" htmlFor="bk-backend">
              <select id="bk-backend" value={draft.backend} onChange={(e) => setDraft({ ...draft, backend: e.target.value })}>
                {BACKENDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Secret" htmlFor="bk-secret">
              <input id="bk-secret" type="password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} />
            </Field>
            {draft.backend !== 'local' && (
              <Field label="Ref (secret locator in the key manager)" htmlFor="bk-ref">
                <TextInput id="bk-ref" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
