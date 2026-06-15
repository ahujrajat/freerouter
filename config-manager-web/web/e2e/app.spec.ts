import { test, expect } from '@playwright/test'

// The SPA's AuthGate redirects unauthenticated users to /auth/login, which
// (via FakeOidc) round-trips through /auth/callback and lands back on / signed in.
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/auth/login')
  await page.waitForURL('**/')
  await expect(page.getByText('E2E Admin')).toBeVisible()
}

test('signs in and shows the app shell with the environment', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('link', { name: 'General' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'BYOK Keys' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Candidates' })).toBeVisible()
})

test('edits General and the value persists across reload', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'General' }).click()
  const model = page.getByLabel('Default model')
  await model.fill('gemini-2.5-flash')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.reload()
  await page.getByRole('link', { name: 'General' }).click()
  await expect(page.getByLabel('Default model')).toHaveValue('gemini-2.5-flash')
})

test('sets a BYOK key and sees the masked last4 (never the secret)', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'BYOK Keys' }).click()
  await page.getByRole('button', { name: 'Set key' }).click()
  await page.getByLabel('Provider').fill('openai')
  await page.getByLabel('Secret').fill('sk-secret-4242')
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.getByText('openai')).toBeVisible()
  await expect(page.getByText(/4242/)).toBeVisible()
  await expect(page.getByText('sk-secret-4242')).toHaveCount(0)
})

test('optimizes a candidate and the status flips to optimized', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Candidates' }).click()
  await expect(page.getByText('gpt-4o', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Optimize' }).click()
  await expect(page.getByText('optimized', { exact: true })).toBeVisible()
})
