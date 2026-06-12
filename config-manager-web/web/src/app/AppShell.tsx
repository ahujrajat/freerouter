import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { EnvSummary, MeResponse } from '../types.js'
import { EnvSwitcher } from './EnvSwitcher.js'
import { GeneralSection } from '../sections/GeneralSection.js'
import { ProvidersSection } from '../sections/ProvidersSection.js'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
] as const
type SectionId = typeof SECTIONS[number]['id']

export function AppShell({ me }: { me: MeResponse }) {
  const [envs, setEnvs] = useState<EnvSummary[]>([])
  const [envId, setEnvId] = useState<string>('')
  const [section, setSection] = useState<SectionId>('general')

  useEffect(() => {
    api.get<EnvSummary[]>('/api/env').then((list) => {
      setEnvs(list)
      if (list[0] !== undefined) setEnvId(list[0].id)
    })
  }, [])

  const env = envs.find(e => e.id === envId)
  const canWrite = env?.role === 'admin'

  return (
    <div>
      <header className="header">
        <span className="header__brand">FreeRouter Admin</span>
        {envs.length > 0 && <EnvSwitcher envs={envs} value={envId} onChange={setEnvId} />}
        <span className="header__spacer" />
        <span>{me.name}</span>
        <a href="/auth/logout">Sign out</a>
      </header>
      <div className="layout">
        <nav className="nav">
          {SECTIONS.map(s => (
            <a key={s.id} className={s.id === section ? 'active' : ''} href="#"
               onClick={(e) => { e.preventDefault(); setSection(s.id) }}>{s.label}</a>
          ))}
        </nav>
        <main>
          {envId === '' ? <div className="card">No environments available to you.</div>
            : section === 'general' ? <GeneralSection envId={envId} canWrite={canWrite} />
            : <ProvidersSection envId={envId} canWrite={canWrite} />}
        </main>
      </div>
    </div>
  )
}
