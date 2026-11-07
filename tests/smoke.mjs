/**
 * Smoke test for the Electron shell.
 *
 * Launches the app with an isolated profile and port, saves the server URL,
 * checks the proxy and waits for the menu-bar popover.
 *
 * Prerequisite: `npm run dashboard:build` and a reachable wombat-server
 * (default http://127.0.0.1:8000).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47901
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-smoke-'))

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
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
      WOMBAT_POPOVER_DEMO: '1',
    },
  })

  // First run: the settings window.
  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'settings window',
  )
  const settings = app.windows().find(w => w.url().includes('settings.html'))
  await settings.waitForSelector('#server-url', { timeout: 10_000 })
  await settings.fill('#server-url', 'http://127.0.0.1:8000')
  await settings.click('#save')

  // Saving closes settings and opens the dashboard.
  await waitUntil(
    () => app.windows().some(w => w.url().startsWith(`http://127.0.0.1:${PORT}`)),
    15_000,
    'dashboard window',
  )

  // The proxy must serve the API health endpoint.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`)
  assert.equal(health.status, 200, 'proxy /health should return 200')

  // The menu-bar popover (demo flag) should render the service card.
  await waitUntil(
    () => app.windows().some(w => w.url().includes('popover.html')),
    10_000,
    'popover window',
  )
  const popover = app.windows().find(w => w.url().includes('popover.html'))
  await popover.waitForSelector('#service-pill', { timeout: 10_000 })
  const pill = await popover.locator('#service-pill').innerText()
  assert.ok(pill.length > 0, 'service status should render')

  console.log(`smoke ok — service: ${pill}, windows: ${app.windows().length}`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
