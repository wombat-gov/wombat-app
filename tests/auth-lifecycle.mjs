/**
 * Auth expiry and browser-session management E2E (UI Wave U6).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47922
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-auth-'))

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

  const loginStatus = await app.evaluate(async ({ session }, server) => {
    const ses = session.fromPartition('persist:wombat')
    const response = await ses.fetch(`${server}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    return response.status
  }, SERVER)
  assert.equal(loginStatus, 200)
  await dashboard.reload()
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )
  await dashboard.waitForFunction(async () => (await fetch('/api/v1/auth/me')).status === 200, null, { timeout: 15_000 })
  await dashboard.evaluate(() => window.wombatApp.shellAction('refresh'))
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.auth?.signedIn === true
  }, 15_000, 'signed-in state')

  // Create a second browser session for the same admin account.
  const secondLogin = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  assert.equal(secondLogin.status, 200)

  const settings = await openSettings(app)
  await settings.waitForSelector('.tab[data-tab="signin"]', { timeout: 10_000 })
  await settings.click('.tab[data-tab="signin"]')
  await settings.waitForFunction(
    () => document.querySelectorAll('#sessions-list tr').length >= 2,
    null,
    { timeout: 15_000 },
  )
  const sessionRows = await settings.locator('#sessions-list tr').count()
  assert.ok(sessionRows >= 2)
  await settings.evaluate(() => {
    document.querySelector('#sessions-list .actions button')?.click()
  })
  await settings.waitForFunction(
    (before) => document.querySelectorAll('#sessions-list tr').length < before,
    sessionRows,
    { timeout: 15_000 },
  )
  await settings.click('#cancel')

  // Expire the app session and hit a protected endpoint.
  await app.evaluate(async ({ session }) => {
    const ses = session.fromPartition('persist:wombat')
    await ses.clearStorageData({ storages: ['cookies'] })
  })
  await dashboard.evaluate(async () => {
    await fetch('/api/v1/runs?limit=1').catch(() => {})
  })
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return root.querySelector('#offlinebar')?.hidden === false
      && /Session expired/i.test(root.querySelector('#offline-title')?.textContent ?? '')
  }, null, { timeout: 15_000 })
  const padding = await dashboard.evaluate(() => Number.parseInt(getComputedStyle(document.body).paddingTop, 10))
  assert.ok(padding >= 72, `banner should reserve at least 72px, got ${padding}`)

  // Signing back in through the same session clears the expiry banner.
  const relogin = await app.evaluate(async ({ session }, server) => {
    const ses = session.fromPartition('persist:wombat')
    const response = await ses.fetch(`${server}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    return response.status
  }, SERVER)
  assert.equal(relogin, 200)
  await dashboard.evaluate(() => window.wombatApp.shellAction('refresh'))
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return root.querySelector('#offlinebar')?.hidden === true
  }, null, { timeout: 15_000 })

  console.log(`auth lifecycle ok — ${sessionRows} sessions, revocation and expiry banner verified`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
