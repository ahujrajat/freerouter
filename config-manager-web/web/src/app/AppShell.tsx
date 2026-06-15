import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { EnvSummary, MeResponse } from '../types.js'
import { EnvSwitcher } from './EnvSwitcher.js'
import { GeneralSection } from '../sections/GeneralSection.js'
import { ProvidersSection } from '../sections/ProvidersSection.js'
import { RateLimitSection } from '../sections/RateLimitSection.js'
import { BudgetsSection } from '../sections/BudgetsSection.js'
import { RulesSection } from '../sections/RulesSection.js'
import { PricingSection } from '../sections/PricingSection.js'
import { OptimizationSection } from '../sections/OptimizationSection.js'
import { EnvVarsSection } from '../sections/EnvVarsSection.js'
import { ByokSection } from '../sections/ByokSection.js'
import { CandidatesSection } from '../sections/CandidatesSection.js'
import { AuditSection } from '../sections/AuditSection.js'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'ratelimit', label: 'Rate Limit' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'rules', label: 'Rules' },
  { id: 'pricing', label: 'Pricing Overrides' },
  { id: 'optimization', label: 'Optimization' },
  { id: 'envvars', label: 'Env Vars' },
  { id: 'byok', label: 'BYOK Keys' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'audit', label: 'Audit' },
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
          {envId === '' ? <div className="card">No environments available to you.</div> : (() => {
            const props = { envId, canWrite }
            switch (section) {
              case 'general': return <GeneralSection {...props} />
              case 'providers': return <ProvidersSection {...props} />
              case 'ratelimit': return <RateLimitSection {...props} />
              case 'budgets': return <BudgetsSection {...props} />
              case 'rules': return <RulesSection {...props} />
              case 'pricing': return <PricingSection {...props} />
              case 'optimization': return <OptimizationSection {...props} />
              case 'envvars': return <EnvVarsSection {...props} />
              case 'byok': return <ByokSection {...props} />
              case 'candidates': return <CandidatesSection {...props} />
              case 'audit': return <AuditSection {...props} />
            }
          })()}
        </main>
      </div>
    </div>
  )
}
