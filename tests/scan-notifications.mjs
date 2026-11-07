/**
 * Scan center, drop overlay, toast and notification center E2E (UI Wave U2).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47910
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-u2-'))

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
let createdNotificationId = ''
let adminCookies = ''
let adminCsrf = ''

try {
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

  // Scan center opens from the split button; signed-out jobs message is clear.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-action="scan-center"]').click()
  })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#scan-panel')?.hidden === false,
    null,
    { timeout: 10_000 },
  )
  const scanPanel = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    const panel = root.querySelector('#scan-panel')
    return {
      role: panel.getAttribute('role'),
      label: panel.getAttribute('aria-label'),
      empty: root.querySelector('#scan-empty')?.textContent ?? '',
      emptyHidden: root.querySelector('#scan-empty')?.hidden,
    }
  })
  assert.equal(scanPanel.role, 'dialog')
  assert.match(scanPanel.label, /Scan center/)
  await waitUntil(() => dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return /Sign in|No recent scans|Keine|Anmelden/i.test(root.querySelector('#scan-empty')?.textContent ?? '')
  }), 10_000, 'scan jobs message')

  // Injected job rows render progress, status and actions. The panel polls
  // every 5 s, so re-inject until the assertion has observed the row.
  const injectedJob = {
    jobs: [{
      id: 'u2-job',
      status: 'running',
      progress: 42,
      project: 'u2-demo',
      path: '/tmp/u2-demo',
      stage: 'scanning',
      created_at: new Date().toISOString(),
      run_id: null,
      error: null,
    }],
    running: 1,
    watching: { active: false, path: '' },
  }
  await waitUntil(async () => {
    await app.evaluate(({ BrowserWindow }, { origin, payload }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
      win?.webContents.send('scan:jobs', payload)
    }, { origin: APP_ORIGIN, payload: injectedJob })
    await new Promise(resolve => setTimeout(resolve, 60))
    return dashboard.evaluate(() => {
      const root = document.getElementById('wombat-appbar-host').shadowRoot
      const row = root.querySelector('#scan-job-list .job')
      return Boolean(row && row.textContent.includes('u2-demo') && row.querySelector('.progress > span')?.style.width === '42%')
    })
  }, 10_000, 'injected scan job row')

  await dashboard.keyboard.press('Escape')
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#scan-panel')?.hidden === true,
    null,
    { timeout: 5_000 },
  )

  // Full-window drop overlay appears for file drags and disappears on leave.
  const dropState = await dashboard.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['resource "x" "y" {}'], 'main.tf'))
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }))
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    const shown = root.querySelector('#drop-overlay')?.hidden === false
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer, bubbles: true, cancelable: true }))
    const hidden = root.querySelector('#drop-overlay')?.hidden === true
    return { shown, hidden }
  })
  assert.deepEqual(dropState, { shown: true, hidden: true })

  // Toasts render and their action navigates.
  await app.evaluate(({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    win?.webContents.send('shell:toast', {
      id: 'u2-toast',
      level: 'success',
      title: 'U2 toast',
      body: 'Toast body',
      ttl: 20_000,
      action: { kind: 'route', route: 'findings' },
    })
  }, APP_ORIGIN)
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#toast-container')?.textContent?.includes('U2 toast'),
    null,
    { timeout: 10_000 },
  )
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('#toast-container .toast-action').click()
  })
  // The toast action navigates; an unauthenticated dashboard redirects to login.
  await waitUntil(() => /#\/(findings|login)/.test(dashboard.url()), 10_000, 'toast action navigation')

  // Authenticate the app session and create a notification as admin.
  const loginStatus = await app.evaluate(async ({ session }, server) => {
    const ses = session.fromPartition('persist:wombat')
    const response = await ses.fetch(`${server}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    return response.status
  }, SERVER)
  assert.equal(loginStatus, 200, 'app session login')

  // Reload so the dashboard's AuthContext sees the newly set cookies.
  await dashboard.reload()
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )

  const adminLogin = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  assert.equal(adminLogin.status, 200)
  adminCookies = cookieHeader(adminLogin)
  adminCsrf = cookieValue(adminCookies, 'wombat_csrf')
  assert.ok(adminCsrf)

  const title = `U2 notification ${Date.now()}`
  const create = await fetch(`${SERVER}/api/v1/notifications`, {
    method: 'POST',
    headers: {
      cookie: adminCookies,
      'content-type': 'application/json',
      'x-csrf-token': adminCsrf,
    },
    body: JSON.stringify({
      title,
      message: 'Created by the U2 test.',
      category: 'warning',
      target_role: null,
    }),
  })
  const createText = await create.text()
  assert.equal(create.status, 200, createText)
  const created = JSON.parse(createText)
  createdNotificationId = created.data.id

  // The notification center lists it and marks it read on click.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-action="notifications"]').click()
  })
  await dashboard.waitForFunction(
    (expected) => {
      const root = document.getElementById('wombat-appbar-host').shadowRoot
      return Array.from(root.querySelectorAll('.notif-title')).some(node => node.textContent === expected)
    },
    title,
    { timeout: 15_000 },
  )

  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('#notif-mark-all')?.click()
  })
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.notifications?.unread === 0
  }, 15_000, 'mark all read')

  await dashboard.evaluate((expected) => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    const row = Array.from(root.querySelectorAll('.notif')).find(node =>
      node.querySelector('.notif-title')?.textContent === expected,
    )
    row?.click()
  }, title)

  await waitUntil(
    () => dashboard.url().includes('#/notifications'),
    10_000,
    'notification navigation',
  )
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.notifications?.unread === 0
  }, 15_000, 'unread count reset')

  // After login, reopening the scan center no longer shows the signed-out message.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-action="scan-center"]').click()
  })
  await dashboard.waitForFunction(
    () => {
      const root = document.getElementById('wombat-appbar-host').shadowRoot
      const empty = root.querySelector('#scan-empty')
      return empty && !/Sign in|Anmelden/i.test(empty.textContent ?? '')
    },
    null,
    { timeout: 10_000 },
  )

  console.log(`scan/notifications ok — toast action, drop overlay, notification ${createdNotificationId} read`)
} finally {
  if (createdNotificationId && adminCookies && adminCsrf) {
    await fetch(`${SERVER}/api/v1/notifications/${createdNotificationId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookies, 'x-csrf-token': adminCsrf },
    }).catch(() => {})
  }
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
