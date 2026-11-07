/**
 * Shell accessibility gate (UI Wave U0).
 *
 * Runs axe-core against the standalone shell windows (Settings, command
 * palette, Help) and fails on critical/serious WCAG 2.x findings. The app bar
 * lives in an open shadow root inside the dashboard; its ARIA/keyboard
 * behaviour is covered by tests/ui-foundations.mjs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

const PORT = 47906
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-a11y-'))

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

async function auditPage(page, label) {
  await page.addScriptTag({ content: AXE_SOURCE })
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })
    return result.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 3).map(node => node.target),
    }))
  })
  const serious = violations.filter(v => v.impact === 'critical' || v.impact === 'serious')
  if (serious.length) {
    console.error(`[a11y:${label}]`, JSON.stringify(serious, null, 2))
  }
  assert.deepEqual(serious, [], `${label} must have no critical/serious axe findings`)
  return violations
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
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_SKIP_ONBOARDING: '1', WOMBAT_UI_TABS: '1' },
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

  const settings = await openSettings(app)
  await settings.waitForSelector('#server-url', { timeout: 10_000 })
  for (const tab of ['connection', 'signin', 'appearance', 'scans', 'advanced']) {
    await settings.click(`.tab[data-tab="${tab}"]`)
    await auditPage(settings, `settings-${tab}`)
  }
  await settings.click('#cancel')

  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-action="palette"]').click()
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('palette.html')),
    10_000,
    'palette window',
  )
  const palette = app.windows().find(w => w.url().includes('palette.html'))
  await palette.waitForSelector('#query', { timeout: 10_000 })
  await palette.fill('#query', 'wombat')
  await palette.waitForFunction(
    () => document.querySelectorAll('.item[role="option"]').length > 0,
    null,
    { timeout: 10_000 },
  )
  await auditPage(palette, 'palette')
  await palette.keyboard.press('Escape')
  await palette.keyboard.press('Escape')

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
  await help.waitForSelector('body', { timeout: 10_000 })
  await help.waitForFunction(() => (document.getElementById('whats-new-list')?.textContent ?? '').length > 20, null, { timeout: 10_000 })
  await help.click('[data-tab="sbom"]')
  await help.waitForFunction(() => (document.getElementById('license-summary')?.textContent ?? '').length > 0, null, { timeout: 10_000 })
  await help.click('[data-tab="about"]')
  await auditPage(help, 'help')

  // Audit the injected app-bar shadow root. Main-process executeJavaScript
  // bypasses the dashboard CSP, unlike an inline <script> injection.
  const shadowViolations = await app.evaluate(async ({ BrowserWindow }, { origin, source }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    if (!win) return []
    await win.webContents.executeJavaScript(source)
    return win.webContents.executeJavaScript(`
      new Promise(resolve => {
        axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
          .then(result => resolve(result.violations
            .filter(v => v.nodes.some(n => JSON.stringify(n.target).includes('wombat-appbar-host')))
            .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.map(n => n.target), html: v.nodes.map(n => n.html) }))))
          .catch(error => resolve([{ id: 'axe-error', impact: 'critical', help: String(error), nodes: 0 }]))
      })
    `)
  }, { origin: APP_ORIGIN, source: AXE_SOURCE })
  const shadowSerious = shadowViolations.filter(v => v.impact === 'critical' || v.impact === 'serious')
  if (shadowSerious.length) console.error('[a11y:appbar]', JSON.stringify(shadowSerious, null, 2))
  assert.deepEqual(shadowSerious, [], 'app bar must have no critical/serious axe findings')

  // Onboarding overlay audit (forced through the main-process event).
  await app.evaluate(({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    win?.webContents.send('shell:onboarding', { showOnboarding: true, showWhatsNew: false, version: 'test', items: [] })
  }, APP_ORIGIN)
  await dashboard.waitForFunction(
    () => document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding')?.hidden === false,
    null,
    { timeout: 10_000 },
  )
  const onboardingViolations = await app.evaluate(async ({ BrowserWindow }, { origin, source }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin))
    if (!win) return []
    await win.webContents.executeJavaScript(source)
    return win.webContents.executeJavaScript(`
      new Promise(resolve => {
        axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
          .then(result => resolve(result.violations
            .filter(v => v.nodes.some(n => JSON.stringify(n.target).includes('onboarding')))
            .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }))))
          .catch(error => resolve([{ id: 'axe-error', impact: 'critical', help: String(error), nodes: 0 }]))
      })
    `)
  }, { origin: APP_ORIGIN, source: AXE_SOURCE })
  const onboardingSerious = onboardingViolations.filter(v => v.impact === 'critical' || v.impact === 'serious')
  if (onboardingSerious.length) console.error('[a11y:onboarding]', JSON.stringify(onboardingSerious, null, 2))
  assert.deepEqual(onboardingSerious, [], 'onboarding must have no critical/serious axe findings')
  await dashboard.evaluate(() => {
    document.getElementById('wombat-appbar-host').shadowRoot.querySelector('#onboarding-skip')?.click()
  })

  // Global ? opens Help directly on Shortcuts.
  await help.click('#close')
  await dashboard.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
  })
  await waitUntil(
    () => app.windows().some(w => w.url().includes('help.html')),
    10_000,
    'help window reopened',
  )
  await help.waitForFunction(
    () => document.querySelector('.tab.active')?.dataset.tab === 'shortcuts',
    null,
    { timeout: 10_000 },
  )

  console.log('a11y ok — Settings, palette, Help, app bar, tabs, onboarding and ? shortcut verified')
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
