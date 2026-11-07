/**
 * Device-authorization smoke test (Wave D).
 *
 * Launches the app with an isolated profile, starts the browser device flow
 * from Server Settings (without actually opening a browser), approves the code
 * with an admin session over HTTP, and checks:
 *   - the waiting status shows the user code,
 *   - the token is stored encrypted (no plaintext in config.json),
 *   - the loopback proxy injects the Bearer token (/auth/me succeeds),
 *   - sign-out revokes the device and returns to 401.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47903
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-device-'))

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function cookieHeader(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []
  return cookies.map(cookie => cookie.split(';')[0]).join('; ')
}

function cookieValue(header, name) {
  return header.split('; ').map(part => part.split('=')).find(([key]) => key === name)?.[1] ?? ''
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
      WOMBAT_DEVICE_NO_BROWSER: '1',
      WOMBAT_TEST_AUTO_CONFIRM: '1',
    },
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'settings window',
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

  // Saving closes the first-run settings window; reopen it via the app menu.
  await waitUntil(
    () => !app.windows().some(w => w.url().includes('settings.html')),
    5_000,
    'first-run settings to close',
  )
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
    'reopened settings window',
  )
  const deviceSettings = app.windows().find(w => w.url().includes('settings.html'))
  await deviceSettings.waitForSelector('.tab[data-tab="signin"]', { timeout: 10_000 })
  await deviceSettings.click('.tab[data-tab="signin"]')
  await deviceSettings.waitForSelector('#device-signin', { state: 'visible', timeout: 10_000 })
  assert.doesNotMatch(await deviceSettings.locator('#device-status').innerText(), /Signed in as/i)

  await deviceSettings.click('#device-signin')
  await deviceSettings.waitForFunction(
    () => /code [A-Z2-9]{4}-[A-Z2-9]{4}/.test(document.getElementById('device-status')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  )
  const waitingText = await deviceSettings.locator('#device-status').innerText()
  const userCode = waitingText.match(/code ([A-Z2-9]{4}-[A-Z2-9]{4})/)[1]
  assert.ok(userCode, 'user code should be visible')

  // Approve the code with a normal browser-style session.
  const loginResponse = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  assert.equal(loginResponse.status, 200, 'admin login should succeed')
  const cookies = cookieHeader(loginResponse)
  const csrf = cookieValue(cookies, 'wombat_csrf')
  assert.ok(csrf, 'login should set a CSRF cookie')

  const approveResponse = await fetch(`${SERVER}/api/v1/auth/device/approve`, {
    method: 'POST',
    headers: {
      cookie: cookies,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ user_code: userCode, action: 'approve', csrf }),
  })
  assert.equal(approveResponse.status, 200, 'approval should succeed')
  assert.match(await approveResponse.text(), /Device approved/)

  await deviceSettings.waitForFunction(
    () => /Signed in as admin/i.test(document.getElementById('device-status')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  )

  // Device list shows the current device.
  await deviceSettings.waitForFunction(
    () => Boolean(document.querySelector('#devices-list .tag.current')),
    null,
    { timeout: 15_000 },
  )
  const deviceRows = await deviceSettings.locator('#devices-list tr').count()
  assert.ok(deviceRows >= 1, 'device list should contain the new device')

  // The state hub reflects the device identity.
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.auth?.signedIn === true && state.auth.method === 'device' && state.auth.user?.username === 'admin'
  }, 15_000, 'state hub device auth')

  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return /admin/i.test(root?.querySelector('.chip.account .chip-name')?.textContent ?? '')
  }, null, { timeout: 10_000 })

  const rawConfig = await readFile(path.join(USER_DATA, 'config.json'), 'utf8')
  assert.ok(rawConfig.includes('deviceAuth'), 'config should persist device auth')
  assert.ok(!rawConfig.includes('wombat_dev_'), 'config must not contain a plaintext device token')
  assert.ok(rawConfig.includes('tokenEnc'), 'token should be encrypted at rest')

  // The proxy injects Authorization: Bearer ... for the active environment.
  await waitUntil(async () => {
    try {
      const status = await dashboard.evaluate(async () => {
        const response = await fetch('/api/v1/auth/me', { credentials: 'include' })
        return response.status
      })
      return status === 200
    } catch {
      return false
    }
  }, 15_000, 'proxy-authenticated /auth/me')

  const currentUser = await dashboard.evaluate(async () => {
    const response = await fetch('/api/v1/auth/me')
    return response.json()
  })
  assert.equal(currentUser.username, 'admin')

  // Revoke the current device from the Settings device table.
  const revokeButton = deviceSettings.locator('#devices-list tr .actions button').first()
  await revokeButton.waitFor({ state: 'visible', timeout: 10_000 })
  await revokeButton.click()

  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.auth?.signedIn === false
  }, 15_000, 'state hub signed out')

  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return /Sign in|Anmelden/i.test(root?.querySelector('.chip.account .chip-name')?.textContent ?? '')
  }, null, { timeout: 15_000 })

  const afterSignOut = await waitUntil(async () => {
    const status = await dashboard.evaluate(async () => {
      const response = await fetch('/api/v1/auth/me')
      return response.status
    })
    return status === 401
  }, 20_000, 'device token revocation').then(() => 401).catch(() => 200)
  assert.equal(afterSignOut, 401, 'sign-out should revoke the device token')

  console.log(`device auth ok — user code ${userCode}, sign-in and revocation verified`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
