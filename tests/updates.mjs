/**
 * Update state machine E2E (UI Wave U4): local manifest, checksum, download.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47917
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-update-'))

const payload = Buffer.from('wombatpass test update payload\n')
const sha256 = createHash('sha256').update(payload).digest('hex')

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

let server
let app
try {
  server = http.createServer((request, response) => {
    if (request.url?.startsWith('/latest.json')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        version: '99.0.0',
        notes: 'U4 test update notes',
        url: `http://127.0.0.1:${server.address().port}/update.bin`,
        sha256,
        size: payload.length,
      }))
      return
    }
    if (request.url === '/update.bin') {
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('content-length', String(payload.length))
      response.end(payload)
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const feed = `http://127.0.0.1:${server.address().port}/latest.json`

  app = await electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA}`],
    cwd: process.cwd(),
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_SKIP_ONBOARDING: '1', WOMBAT_LOCALE: 'en' },
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

  // Seed the update feed into the persisted preferences.
  const config = JSON.parse(await readFile(path.join(USER_DATA, 'config.json'), 'utf8'))
  config.preferences = { ...(config.preferences ?? {}), updateFeedUrl: feed }
  await writeFile(path.join(USER_DATA, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)

  const settings = await openSettings(app)
  await settings.waitForSelector('.tab[data-tab="advanced"]', { timeout: 10_000 })
  await settings.click('.tab[data-tab="advanced"]')
  await settings.waitForSelector('#update-feed', { state: 'visible', timeout: 10_000 })
  assert.equal(await settings.locator('#update-feed').inputValue(), feed)

  await settings.click('#check-updates')
  await settings.waitForFunction(
    () => /is available/i.test(document.getElementById('update-status')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  )
  assert.equal(await settings.locator('#download-update').isVisible(), true)
  assert.match(await settings.locator('#update-notes').innerText(), /U4 test update notes/)

  await settings.click('#download-update')
  await settings.waitForFunction(
    () => /ready to install/i.test(document.getElementById('update-status')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  )
  assert.equal(await settings.locator('#open-update').isVisible(), true)

  const state = await settings.evaluate(() => window.wombatSettings.updatesGet())
  assert.equal(state.state, 'ready')
  assert.equal(state.latest, '99.0.0')
  assert.equal(state.downloadedBytes, payload.length)
  assert.equal(state.sha256, sha256)
  assert.ok(state.filePath.includes('wombatpass-updates'))

  await settings.click('#cancel')
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#update-chip')?.hidden === false,
    null,
    { timeout: 10_000 },
  )
  const chip = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return root.querySelector('#update-chip .chip-name')?.textContent
  })
  assert.match(chip, /Install update/i)

  await waitUntil(async () => {
    const shell = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return shell?.update?.state === 'ready'
  }, 10_000, 'shell update state')

  console.log(`updates ok — ${state.latest}, ${state.downloadedBytes} bytes, sha256 verified, update chip visible`)
} finally {
  await app?.close().catch(() => {})
  await new Promise(resolve => server?.close(resolve))
  await rm(USER_DATA, { recursive: true, force: true })
}
