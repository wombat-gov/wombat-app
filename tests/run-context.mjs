/**
 * Run context bar E2E (UI Wave U3).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47913
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-runbar-'))

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

let app
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
  await dashboard.waitForFunction(async () => {
    const response = await fetch('/api/v1/auth/me')
    return response.status === 200
  }, null, { timeout: 15_000 })
  await dashboard.evaluate(() => { location.hash = '#/dashboard' })
  await dashboard.waitForFunction(() => location.hash !== '#/login', null, { timeout: 10_000 })

  const adminLogin = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  assert.equal(adminLogin.status, 200)
  const cookies = cookieHeader(adminLogin)
  const runsResponse = await fetch(`${SERVER}/api/v1/runs?limit=1`, {
    headers: { cookie: cookies, accept: 'application/json' },
  })
  assert.equal(runsResponse.status, 200)
  const run = (await runsResponse.json()).data[0]
  assert.ok(run?.id, 'a run is required for this test')

  await dashboard.evaluate((id) => {
    location.hash = `#/dashboard?run=${encodeURIComponent(id)}`
  }, run.id)

  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#runbar')?.hidden === false,
    null,
    { timeout: 15_000 },
  )
  await dashboard.waitForFunction(
    (project) => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#runbar-project')?.textContent === project,
    run.project,
    { timeout: 10_000 },
  )
  const bar = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return {
      project: root.querySelector('#runbar-project')?.textContent,
      score: root.querySelector('#runbar-score')?.textContent,
      meta: root.querySelector('#runbar-meta')?.textContent,
      padding: getComputedStyle(document.body).paddingTop,
      title: root.querySelector('#runbar')?.title,
    }
  })
  assert.equal(bar.project, run.project)
  if (typeof run.score === 'number') assert.match(bar.score, new RegExp(`${run.score}/100`))
  assert.match(bar.meta, new RegExp(run.branch || '.'))
  assert.equal(bar.padding, '70px')
  assert.match(bar.title, new RegExp(run.id))

  // Copy link.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-run-action="copy"]').click()
  })
  const copied = await app.evaluate(async ({ clipboard }) => clipboard.readText())
  assert.equal(await copied, `wombatpass://run/${run.id}`)

  // Findings action keeps the run context.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-run-action="findings"]').click()
  })
  await waitUntil(
    () => dashboard.url().includes(`#/findings?run=${encodeURIComponent(run.id)}`),
    10_000,
    'findings navigation',
  )
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#runbar')?.hidden === false,
    null,
    { timeout: 10_000 },
  )

  // Closing restores the normal page offset.
  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-run-action="close"]').click()
  })
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#runbar')?.hidden === true,
    null,
    { timeout: 5_000 },
  )
  const padding = await dashboard.evaluate(() => getComputedStyle(document.body).paddingTop)
  assert.equal(padding, '38px')

  // Navigating to a route without a run keeps the bar hidden.
  await dashboard.evaluate(() => { location.hash = '#/runs' })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(
    await dashboard.evaluate(() => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#runbar')?.hidden),
    true,
  )

  console.log(`run context ok — ${run.project}, score ${run.score}, copy/findings/close verified`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
