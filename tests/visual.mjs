/**
 * Screenshot regression gate (UI Wave U6).
 *
 * Baselines are platform-specific. Run with WOMBAT_UPDATE_VISUAL=1 to refresh;
 * set WOMBAT_REQUIRE_VISUAL=1 to fail when a baseline is missing.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const PORT = 47925
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-visual-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLATFORM = `${process.platform}-${process.arch}`
const BASELINE_DIR = path.join(HERE, 'visual-baselines', PLATFORM)
const UPDATE = process.env.WOMBAT_UPDATE_VISUAL === '1'
const REQUIRE = process.env.WOMBAT_REQUIRE_VISUAL === '1'

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      /* retry */
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function compare(name, buffer) {
  await mkdir(BASELINE_DIR, { recursive: true })
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`)
  if (UPDATE) {
    await writeFile(baselinePath, buffer)
    console.log(`[visual] wrote ${path.relative(HERE, baselinePath)}`)
    return
  }
  let baseline
  try {
    baseline = await readFile(baselinePath)
  } catch {
    if (REQUIRE) throw new Error(`missing visual baseline ${baselinePath}`)
    await writeFile(baselinePath, buffer)
    console.log(`[visual] baseline created ${path.relative(HERE, baselinePath)} (run again to compare)`)
    return
  }
  const expected = PNG.sync.read(baseline)
  const actual = PNG.sync.read(buffer)
  assert.equal(actual.width, expected.width, `${name} width`)
  assert.equal(actual.height, expected.height, `${name} height`)
  const diff = new PNG({ width: actual.width, height: actual.height })
  const changed = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.12 })
  const ratio = changed / (actual.width * actual.height)
  if (ratio > 0.005) {
    const diffPath = path.join(BASELINE_DIR, `${name}.diff.png`)
    await writeFile(diffPath, PNG.sync.write(diff))
    throw new Error(`visual diff ${name}: ${(ratio * 100).toFixed(2)}% (see ${diffPath})`)
  }
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
    env: {
      ...process.env,
      WOMBAT_PORT: String(PORT),
      WOMBAT_LOCALE: 'en',
      WOMBAT_THEME: 'dark',
      WOMBAT_SKIP_ONBOARDING: '1',
    },
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
  await dashboard.waitForFunction(
    () => Boolean(document.getElementById('wombat-appbar-host')?.shadowRoot),
    null,
    { timeout: 15_000 },
  )
  await new Promise(resolve => setTimeout(resolve, 400))
  await compare('appbar', await dashboard.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 38 } }))

  const settings = await openSettings(app)
  await settings.waitForSelector('.tab[data-tab="appearance"]', { timeout: 10_000 })
  await settings.click('.tab[data-tab="appearance"]')
  await settings.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 10_000 })
  await new Promise(resolve => setTimeout(resolve, 300))
  await compare('settings-appearance', await settings.screenshot())
  await settings.click('#cancel')

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
  await palette.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 10_000 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await compare('palette-empty', await palette.screenshot())

  console.log(`visual ok — ${PLATFORM} baselines compared`)
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
