import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import { AuthGate } from './auth/AuthGate.js'
import { AppShell } from './app/AppShell.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{(me) => <AppShell me={me} />}</AuthGate>
  </StrictMode>,
)
