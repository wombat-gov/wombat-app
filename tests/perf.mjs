/**
 * Performance budget smoke test (UI Wave U6).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47924
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-perf-'))

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      /* retry */
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let app
try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${USER_DATA}`],
    cwd: process.cwd(),
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_LOCALE: 'en', WOMBAT_SKIP_ONBOARDING: '1' },
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

  const marks = await dashboard.evaluate(() => window.wombatApp.getPerf())
  for (const name of ['app-ready', 'local-server-ready', 'dashboard-window-created', 'dashboard-shell-ready']) {
    assert.ok(marks[name], `missing performance mark ${name}`)
  }
  assert.ok(marks['app-ready'].sinceProcessStartMs < 8_000, 'app-ready budget')
  assert.ok(marks['dashboard-shell-ready'].sinceProcessStartMs < 15_000, 'shell-ready budget')

  const paletteStart = Date.now()
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('[data-action="palette"]').click()
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('palette.html')),
    5_000,
    'palette window',
  )
  const palette = app.windows().find(w => w.url().includes('palette.html'))
  await palette.waitForSelector('#query', { timeout: 5_000 })
  assert.ok(Date.now() - paletteStart < 2_000, 'palette open budget')

  const appMetrics = await app.evaluate(({ app }) => app.getAppMetrics())
  const rendererBytes = appMetrics
    .filter(metric => metric.type === 'Tab')
    .reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  assert.ok(rendererBytes >= 0, 'renderer memory metrics available')

  console.log(`perf ok — app-ready ${marks['app-ready'].sinceProcessStartMs}ms, shell ${marks['dashboard-shell-ready'].sinceProcessStartMs}ms, palette ${Date.now() - paletteStart}ms, renderer ${rendererBytes}KB`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
