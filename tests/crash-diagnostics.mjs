/**
 * Offline banner, crash page and diagnostics E2E (UI Wave U4).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47916
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-crash-'))

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
      WOMBAT_SKIP_ONBOARDING: '1',
      WOMBAT_PORT: String(PORT),
      WOMBAT_LOCALE: 'en',
      WOMBAT_CRASH_RETRY_LIMIT: '0',
    },
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
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )

  // Plant a fake token: diagnostics must never include device credentials.
  const configPath = path.join(USER_DATA, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.deviceAuth = { local: { tokenEnc: 'SECRET-DEVICE-TOKEN', username: 'admin' } }
  config.preferences = { ...(config.preferences ?? {}), crashReports: true }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  // Offline banner rendering and layout.
  const onlineState = await dashboard.evaluate(() => window.wombatApp.getShellState())
  await app.evaluate(({ BrowserWindow }, { origin, state }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    win?.webContents.send('shell:state', {
      ...state,
      environment: { ...state.environment, health: 'offline', lastSyncAt: new Date().toISOString() },
      connection: { state: 'offline', error: 'connect ECONNREFUSED', since: new Date().toISOString() },
    })
  }, { origin: APP_ORIGIN, state: onlineState })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#offlinebar')?.hidden === false,
    null,
    { timeout: 10_000 },
  )
  const offline = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return {
      title: root.querySelector('#offline-title')?.textContent,
      meta: root.querySelector('#offline-meta')?.textContent,
      padding: getComputedStyle(document.body).paddingTop,
      buttons: root.querySelectorAll('#offlinebar button:not([hidden])').length,
    }
  })
  assert.match(offline.title, /unreachable/i)
  assert.match(offline.meta, /Last sync/i)
  assert.equal(offline.padding, '72px')
  assert.equal(offline.buttons, 3)

  await app.evaluate(({ BrowserWindow }, { origin, state }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    win?.webContents.send('shell:state', state)
  }, { origin: APP_ORIGIN, state: onlineState })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#offlinebar')?.hidden === true,
    null,
    { timeout: 10_000 },
  )

  // Help → Diagnostics uses the redacted main-process bundle.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-action="help"]').click()
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('help.html')),
    10_000,
    'help window',
  )
  const help = app.windows().find(w => w.url().includes('help.html'))
  await help.waitForSelector('[data-tab="diagnostics"]', { timeout: 10_000 })
  await help.click('[data-tab="diagnostics"]')
  await help.click('#copy-diagnostics')
  await help.waitForFunction(
    () => document.getElementById('diag-status')?.textContent?.includes('copied'),
    null,
    { timeout: 10_000 },
  )
  const diagnosticsText = await app.evaluate(async ({ clipboard }) => clipboard.readText())
  const diagnostics = JSON.parse(await diagnosticsText)
  assert.ok(diagnostics.generatedAt)
  assert.ok(!/wombat_dev_[A-Za-z0-9]/.test(await diagnosticsText))
  assert.equal((await diagnosticsText).includes('SECRET-DEVICE-TOKEN'), false, 'diagnostics must not include device tokens')
  assert.equal(diagnostics.auth.method !== undefined, true)
  await help.click('#close')

  // Crash the renderer; with the retry limit at 0 the crash page is shown.
  await app.evaluate(({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    win?.webContents.forcefullyCrashRenderer()
  }, APP_ORIGIN)

  await waitUntil(
    () => app.windows().some(w => w.url().includes('crash.html')),
    20_000,
    'crash page',
  )
  const crash = app.windows().find(w => w.url().includes('crash.html'))
  await crash.waitForSelector('#reload', { timeout: 10_000 })
  assert.equal(await crash.locator('#safe').isVisible(), true)
  assert.match(await crash.locator('#detail').innerText(), /Version:/)

  await crash.click('#copy')
  await crash.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('copied'),
    null,
    { timeout: 10_000 },
  )
  const crashDiagnostics = JSON.parse(await app.evaluate(async ({ clipboard }) => clipboard.readText()))
  assert.equal(crashDiagnostics.crash.reason.length > 0, true)

  // Opt-in local crash report was written next to the profile.
  const reports = await readdir(path.join(USER_DATA, 'crash-reports')).catch(() => [])
  assert.ok(reports.some(name => name.endsWith('.json')), 'local crash report should be saved')

  // Safe-mode reload removes the injected shell bar.
  await crash.click('#safe')
  await waitUntil(
    () => app.windows().some(w => w.url().includes('?safe=1')),
    15_000,
    'safe-mode dashboard',
  )
  const safe = app.windows().find(w => w.url().includes('?safe=1'))
  await safe.waitForLoadState('domcontentloaded')
  assert.equal(
    await safe.evaluate(() => Boolean(document.getElementById('wombat-appbar-host'))),
    false,
  )

  console.log(`crash/diagnostics ok — reason ${crashDiagnostics.crash.reason}, safe mode verified`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
