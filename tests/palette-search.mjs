/**
 * Palette search smoke test (Wave C).
 *
 * Requires a reachable wombat-server (default http://127.0.0.1:8000) with the
 * admin/admin local account and the /api/v1/search endpoint. Runs with an
 * isolated profile on its own port, logs the session in through the app's
 * persistent partition, then drives the palette UI and checks server-ranked
 * results and navigation.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47902
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-palette-'))

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
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_SKIP_ONBOARDING: '1', WOMBAT_LOCALE: 'en' },
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

  // Authenticate the persistent session (cookies are shared across ports).
  const loginStatus = await app.evaluate(async ({ session }, server) => {
    const ses = session.fromPartition('persist:wombat')
    const response = await ses.fetch(`${server}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    return response.status
  }, SERVER)
  assert.equal(loginStatus, 200, 'admin login should succeed')

  const searchStatus = await app.evaluate(async ({ session }, origin) => {
    const ses = session.fromPartition('persist:wombat')
    const response = await ses.fetch(`${origin}/api/v1/search?q=WAF-SEC&limit=5`, {
      credentials: 'include',
    })
    return { status: response.status, body: await response.json() }
  }, APP_ORIGIN)
  assert.equal(searchStatus.status, 200, 'search via proxy should succeed')
  assert.ok(searchStatus.body.data.length > 0, 'search should return results')

  const dashboard = app.windows().find(w => w.url().startsWith(APP_ORIGIN))
  await dashboard.reload()
  await dashboard.waitForLoadState('domcontentloaded')
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )

  await dashboard.evaluate(() => {
    const host = document.getElementById('wombat-appbar-host')
    host.shadowRoot.querySelector('button[data-action="palette"]').click()
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('palette.html')),
    10_000,
    'palette window',
  )
  const palette = app.windows().find(w => w.url().includes('palette.html'))
  await palette.waitForSelector('#query', { timeout: 10_000 })

  async function expectBadge(value, badge) {
    await palette.fill('#query', value)
    await palette.waitForFunction((expected) => {
      const badges = [...document.querySelectorAll('.item .badge')].map(node => node.textContent)
      return badges.includes(expected)
    }, badge, { timeout: 10_000 })
    const badges = await palette.locator('.item .badge').allInnerTexts()
    assert.ok(badges.length > 0)
  }

  await expectBadge('>theme: light', 'Action')
  await expectBadge('@wombat', 'Run')
  await expectBadge('#WAF-SEC', 'Control')
  await expectBadge(':find', 'Page')
  await expectBadge('~', 'Env')

  await palette.fill('#query', 'WAF-SEC')
  await palette.waitForFunction(() => {
    const badges = [...document.querySelectorAll('.item .badge')].map(node => node.textContent)
    return badges.includes('Control')
  }, null, { timeout: 10_000 })

  const controlLabels = await palette.locator('.item .label').allInnerTexts()
  assert.ok(
    controlLabels.some(label => label.startsWith('WAF-SEC-')),
    `expected control results, got ${JSON.stringify(controlLabels)}`,
  )
  const hint = await palette.locator('#hint').innerText()
  assert.ok(/result/i.test(hint), `expected result hint, got ${hint}`)

  const marks = await palette.locator('.item .label mark').count()
  assert.ok(marks > 0, 'matching term should be highlighted')

  // Pin the selected control with Cmd/Ctrl+D, then check Favorites.
  await palette.press('#query', process.platform === 'darwin' ? 'Meta+d' : 'Control+d')
  await palette.fill('#query', '')
  await palette.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.section')].map(node => node.textContent)
    return sections.includes('FAVORITES') || sections.includes('Favorites')
  }, null, { timeout: 10_000 })
  const favoriteText = await palette.locator('#list').innerText()
  assert.match(favoriteText, /WAF-SEC/i)

  await palette.fill('#query', 'wombat')
  await palette.waitForFunction(() => {
    const badges = [...document.querySelectorAll('.item .badge')].map(node => node.textContent)
    return badges.includes('Run')
  }, null, { timeout: 10_000 })

  // Execute the Run result and confirm the dashboard navigates to its run.
  await palette.evaluate(() => {
    const run = [...document.querySelectorAll('.item')].find(item =>
      item.querySelector('.badge')?.textContent === 'Run',
    )
    run?.click()
  })

  await waitUntil(
    () => /#\/dashboard\?run=/.test(dashboard.url()),
    10_000,
    'dashboard run navigation',
  )

  // Reopening the palette shows the recorded command and search history.
  await dashboard.evaluate(() => {
    const host = document.getElementById('wombat-appbar-host')
    host.shadowRoot.querySelector('button[data-action="palette"]').click()
  })
  await palette.waitForFunction(() => {
    const title = [...document.querySelectorAll('.section')].map(node => node.textContent)
    return title.includes('RECENT') || title.includes('Recent')
  }, null, { timeout: 10_000 })

  const recentText = await palette.locator('#list').innerText()
  assert.match(recentText, /wombat-demo|wombat/i, 'executed run should appear in recents')
  assert.match(recentText, /wombat/i, 'search term should appear in recents')

  // Shell commands are executable from the palette.
  await palette.fill('#query', '>theme: light')
  await palette.waitForFunction(() => {
    return [...document.querySelectorAll('.item')].some(item => item.textContent?.includes('Theme: Light'))
  }, null, { timeout: 10_000 })
  await palette.evaluate(() => {
    const item = [...document.querySelectorAll('.item')].find(node => node.textContent?.includes('Theme: Light'))
    item?.click()
  })
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.ui?.theme === 'light'
  }, 10_000, 'theme command')

  await dashboard.evaluate(() => {
    const host = document.getElementById('wombat-appbar-host')
    host.shadowRoot.querySelector('button[data-action="palette"]').click()
  })
  await palette.waitForFunction(() => document.getElementById('list').innerText.includes('Theme: Light'), null, { timeout: 10_000 })

  console.log(`palette 2 ok — prefixes, recents, theme command; control results: ${controlLabels.length}`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
