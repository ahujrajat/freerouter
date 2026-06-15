import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? '7799')

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    command: `node --import tsx e2e/harness.ts`,
    url: `http://127.0.0.1:${PORT}/auth/me`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT) },
    // /auth/me returns 401 before login — treat any HTTP response as "up".
    ignoreHTTPSErrors: true,
  },
})
