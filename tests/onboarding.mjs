/**
 * First-run tour and What's New E2E (UI Wave U5).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47919
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-onboarding-'))

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
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_LOCALE: 'en' },
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'first-run settings',
  )
  const settings = app.windows().find(w => w.url().includes('settings.html'))
  await settings.waitForSelector('#server-url', { timeout: 10_000 })
  await settings.fill('#server-url', SERVER)
  await settings.click('#save')

  await waitUntil(
    () => app.windows().some(w => w.url().startsWith(APP_ORIGIN)),
    15_000,
    'dashboard window',
  )
  const dashboard = app.windows().find(w => w.url().startsWith(APP_ORIGIN))

  // Sign in so the tour is not suppressed on the login screen.
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
  await dashboard.evaluate(() => { location.hash = '#/dashboard' })

  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding')?.hidden === false,
    null,
    { timeout: 15_000 },
  )
  const tour = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return {
      title: root.querySelector('#onboarding-title')?.textContent,
      step: root.querySelector('#onboarding-step')?.textContent,
    }
  })
  assert.equal(tour.title, 'Your desktop shell')
  assert.match(tour.step, /1 \/ 4/)

  for (let index = 0; index < 3; index += 1) {
    await dashboard.evaluate(() => {
      document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding-next').click()
    })
  }
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding-next').click()
  })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding')?.hidden === true,
    null,
    { timeout: 10_000 },
  )

  const config = JSON.parse(await readFile(path.join(USER_DATA, 'config.json'), 'utf8'))
  assert.ok(config.preferences.onboardingVersion)
  assert.equal(config.preferences.whatsNewSeen, config.preferences.onboardingVersion)

  // Replay What's New from Settings → Advanced.
  const settings2 = await openSettings(app)
  await settings2.waitForSelector('.tab[data-tab="advanced"]', { timeout: 10_000 })
  await settings2.click('.tab[data-tab="advanced"]')
  await settings2.waitForSelector('#show-whatsnew', { state: 'visible', timeout: 10_000 })
  await settings2.click('#show-whatsnew')

  await dashboard.waitForFunction(
    () => {
      const root = document.getElementById('wombat-appbar-host').shadowRoot
      return root.querySelector('#onboarding')?.hidden === false
        && /What's new/i.test(root.querySelector('#onboarding-title')?.textContent ?? '')
    },
    null,
    { timeout: 10_000 },
  )
  const whatsNewText = await dashboard.evaluate(() =>
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding-body')?.textContent ?? '',
  )
  assert.match(whatsNewText, /Undo a closed|Help now|Zoom control|local crash reports/i)

  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding-next').click()
  })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding')?.hidden === true,
    null,
    { timeout: 10_000 },
  )

  console.log(`onboarding ok — ${tour.title}, What's New replayed, versions persisted`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
