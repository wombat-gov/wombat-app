/**
 * Pseudo-locale leak test (UI Wave U6). Runs the shell with every dictionary
 * value wrapped in markers; untranslated hardcoded strings or raw keys fail.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47923
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-pseudo-'))

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      /* retry */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let app
try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WOMBAT_PORT: String(PORT),
      WOMBAT_LOCALE: 'en',
      WOMBAT_PSEUDO_LOCALE: '1',
      WOMBAT_SKIP_ONBOARDING: '1',
    },
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'first-run settings',
  )
  const settings = app.windows().find(w => w.url().includes('settings.html'))
  await settings.waitForSelector('h1', { timeout: 10_000 })
  const settingsTitle = await settings.locator('h1').innerText()
  assert.match(settingsTitle, /⟦.*⟧/, `settings title should be pseudo-localized: ${settingsTitle}`)

  await settings.fill('#server-url', SERVER)
  await settings.click('#save')
  await waitUntil(
    () => app.windows().some(w => w.url().startsWith(APP_ORIGIN)),
    15_000,
    'dashboard window',
  )
  const dashboard = app.windows().find(w => w.url().startsWith(APP_ORIGIN))
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('[data-route="dashboard"]')?.textContent?.includes('⟦') === true
  }, null, { timeout: 15_000 })

  const navLabels = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return [...root.querySelectorAll('.link, .action [data-i18n]')].map(node => node.textContent)
  })
  assert.ok(navLabels.length > 0)
  for (const label of navLabels) {
    assert.match(label, /⟦.*⟧/, `shell label should be pseudo-localized: ${label}`)
  }

  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('[data-action="palette"]').click()
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('palette.html')),
    10_000,
    'palette window',
  )
  const palette = app.windows().find(w => w.url().includes('palette.html'))
  await palette.waitForFunction(() => /⟦.*⟧/.test(document.getElementById('query')?.placeholder ?? ''), null, { timeout: 10_000 })
  const placeholder = await palette.locator('#query').getAttribute('placeholder')
  assert.match(placeholder, /⟦.*⟧/)

  console.log('pseudo-locale ok — Settings, app bar and palette strings are dictionary-backed')
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
