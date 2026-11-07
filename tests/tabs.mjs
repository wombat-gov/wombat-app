/**
 * Cross-platform tab strip E2E (UI Wave U5).
 * Runs the Windows/Linux code path on macOS with WOMBAT_UI_TABS=1.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47920
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-tabs-'))

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

function launch() {
  return electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WOMBAT_PORT: String(PORT),
      WOMBAT_LOCALE: 'en',
      WOMBAT_UI_TABS: '1',
      WOMBAT_SKIP_ONBOARDING: '1',
    },
  })
}

async function tabCount(page) {
  return page.evaluate(() =>
    document.getElementById('wombat-appbar-host')?.shadowRoot.querySelectorAll('#tabstrip .tab').length ?? 0,
  )
}

let app = await launch()
try {
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
    () => document.getElementById('wombat-appbar-host')?.shadowRoot.querySelector('#tabstrip')?.hidden === false,
    null,
    { timeout: 15_000 },
  )
  assert.equal(await tabCount(dashboard), 1)

  // Open a second tab via the palette's "new window" action.
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('[data-action="palette"]').click()
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('palette.html')),
    10_000,
    'palette window',
  )
  const palette = app.windows().find(w => w.url().includes('palette.html'))
  await palette.waitForSelector('#query', { timeout: 10_000 })
  await palette.fill('#query', '>new window')
  await palette.waitForFunction(
    () => [...document.querySelectorAll('.item')].some(item => /New Window/i.test(item.textContent ?? '')),
    null,
    { timeout: 10_000 },
  )
  await palette.evaluate(() => {
    const item = [...document.querySelectorAll('.item')].find(node => /New Window/i.test(node.textContent ?? ''))
    item?.click()
  })

  await waitUntil(async () => (await tabCount(dashboard)) === 2, 15_000, 'second tab')
  await dashboard.waitForFunction(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    return tabs.length === 2 && tabs[1]?.classList.contains('active') === true
  }, null, { timeout: 15_000 })

  // Activate the first tab, then close the second.
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')[0].click()
  })
  await dashboard.waitForFunction(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    return tabs[0]?.classList.contains('active') === true
  }, null, { timeout: 10_000 })

  await dashboard.evaluate(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    tabs[1]?.parentElement?.querySelector('.tab-close')?.click()
  })
  await waitUntil(async () => (await tabCount(dashboard)) === 1, 10_000, 'second tab closed')

  // Undo the close from its toast, then close it again.
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return /Tab closed/i.test(root.querySelector('#toast-container')?.textContent ?? '')
  }, null, { timeout: 10_000 })
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#toast-container .toast-action')?.click()
  })
  await waitUntil(async () => (await tabCount(dashboard)) === 2, 15_000, 'undo reopened tab')
  await dashboard.evaluate(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    tabs[1]?.parentElement?.querySelector('.tab-close')?.click()
  })
  await waitUntil(async () => (await tabCount(dashboard)) === 1, 10_000, 'reopened tab closed again')

  // Add a new tab with the + button, then keep two tabs for restore.
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#tabstrip .tab-add').click()
  })
  await waitUntil(async () => (await tabCount(dashboard)) === 2, 15_000, 'new tab button')

  // Drag the second tab before the first.
  const orderBefore = await dashboard.evaluate(() =>
    [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab-item')].map(item => item.dataset.tabId),
  )
  await dashboard.evaluate(() => {
    const items = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab-item')]
    if (items.length < 2) return
    const dataTransfer = new DataTransfer()
    items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    items[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    items[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    items[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await dashboard.waitForFunction((expected) => {
    const first = document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#tabstrip .tab-item')
    return first?.dataset.tabId === expected
  }, orderBefore[1], { timeout: 10_000 })

  // Make the first tab active before quitting; restore should preserve it.
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')[0].click()
  })
  await dashboard.waitForFunction(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    return tabs[0]?.classList.contains('active') === true
  }, null, { timeout: 10_000 })

  // Enable tab restore for the next launch.
  const configPath = path.join(USER_DATA, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.preferences = { ...(config.preferences ?? {}), restoreTabs: true }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  await app.close()
  app = await launch()

  await waitUntil(
    () => app.windows().some(w => w.url().startsWith(APP_ORIGIN)),
    15_000,
    'restored dashboard window',
  )
  const restored = app.windows().find(w => w.url().startsWith(APP_ORIGIN))
  await restored.waitForFunction(
    () => document.getElementById('wombat-appbar-host')?.shadowRoot.querySelector('#tabstrip')?.hidden === false,
    null,
    { timeout: 15_000 },
  )
  await waitUntil(async () => (await tabCount(restored)) === 2, 15_000, 'restored tabs')
  await restored.waitForFunction(() => {
    const tabs = [...document.getElementById('wombat-appbar-host').shadowRoot.querySelectorAll('#tabstrip .tab')]
    return tabs.findIndex(tab => tab.classList.contains('active')) === 0
  }, null, { timeout: 5_000 })

  console.log('tabs ok — open, activate, close, add, and restore verified')
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
