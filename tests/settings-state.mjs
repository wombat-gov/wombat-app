/**
 * Settings Apply/Revert, restart banner and test-all E2E (UI Wave U7).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47926
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-settings-'))

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      /* retry */
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function openSettings(app) {
  await app.evaluate(({ Menu }) => {
    const walk = items => {
      for (const item of items) {
        if (item.submenu && walk(item.submenu.items)) return true
        if (/settings|einstellungen/i.test(item.label ?? '')) {
          item.click()
          return true
        }
      }
      return false
    }
    walk(Menu.getApplicationMenu()?.items ?? [])
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    10_000,
    'settings window',
  )
  return app.windows().find(w => w.url().includes('settings.html'))
}

async function readConfig() {
  return JSON.parse(await readFile(path.join(USER_DATA, 'config.json'), 'utf8'))
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
      WOMBAT_SKIP_ONBOARDING: '1',
      WOMBAT_TEST_AUTO_CONFIRM: '1',
      WOMBAT_THEME: 'dark',
    },
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'first-run settings',
  )
  const firstRun = app.windows().find(w => w.url().includes('settings.html'))
  await firstRun.waitForSelector('#server-url', { timeout: 10_000 })
  await firstRun.fill('#server-url', SERVER)
  await firstRun.click('#save')
  await waitUntil(
    () => app.windows().some(w => w.url().startsWith(APP_ORIGIN)),
    15_000,
    'dashboard window',
  )
  const dashboard = app.windows().find(w => w.url().startsWith(APP_ORIGIN))
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )

  // Theme preview is reverted by Cancel.
  let settings = await openSettings(app)
  await settings.waitForSelector('.tab[data-tab="appearance"]', { timeout: 10_000 })
  await settings.click('.tab[data-tab="appearance"]')
  await settings.selectOption('#theme', 'light')
  await settings.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 10_000 })
  await settings.click('#cancel')
  await waitUntil(
    () => !app.windows().some(w => w.url().includes('settings.html')),
    5_000,
    'settings closed',
  )
  let config = await readConfig()
  assert.notEqual(config.preferences.theme, 'light', 'Cancel must revert the previewed theme')

  // Apply an environment rename.
  settings = await openSettings(app)
  await settings.waitForSelector('#env-name', { timeout: 10_000 })
  await settings.fill('#env-name', 'Renamed Local')
  await settings.click('#save')
  await waitUntil(
    () => !app.windows().some(w => w.url().includes('settings.html')),
    10_000,
    'rename applied',
  )
  config = await readConfig()
  assert.equal(config.environments[0].name, 'Renamed Local')

  // Native-chrome changes require a relaunch instead of silently closing.
  settings = await openSettings(app)
  await settings.waitForSelector('.tab[data-tab="appearance"]', { timeout: 10_000 })
  await settings.click('.tab[data-tab="appearance"]')
  await settings.uncheck('#pref-native-chrome')
  await settings.click('#save')
  await settings.waitForFunction(
    () => document.getElementById('relaunch')?.hidden === false,
    null,
    { timeout: 10_000 },
  )
  assert.equal(await settings.locator('#relaunch').isVisible(), true)
  assert.equal((await readConfig()).preferences.nativeChrome, false)
  await settings.click('#cancel')

  // Test all environments.
  settings = await openSettings(app)
  await settings.waitForSelector('#test-all', { timeout: 10_000 })
  await settings.click('#test-all')
  await settings.waitForFunction(
    () => /Renamed Local/.test(document.getElementById('test-all-results')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  )
  const testText = await settings.locator('#test-all-results').innerText()
  assert.match(testText, /Renamed Local/)
  await settings.click('#cancel')

  console.log('settings state ok — preview revert, rename, restart banner, test-all verified')
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
