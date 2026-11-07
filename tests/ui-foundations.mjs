/**
 * UI Wave U0 foundations test.
 *
 * Covers the desktop state hub, live locale switching, app-bar ARIA/roving
 * tabindex, theme application to shell windows, palette listbox semantics and
 * the native-chrome spike markers.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const PORT = 47905
const SERVER = 'http://127.0.0.1:8000'
const APP_ORIGIN = `http://127.0.0.1:${PORT}`
const USER_DATA = await mkdtemp(path.join(tmpdir(), 'wombat-ui-'))

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

async function openSettingsFromMenu(app) {
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
    env: { ...process.env, WOMBAT_PORT: String(PORT), WOMBAT_SKIP_ONBOARDING: '1', WOMBAT_TEST_AUTO_CONFIRM: '1' },
  })

  await waitUntil(
    () => app.windows().some(w => w.url().includes('settings.html')),
    15_000,
    'first-run settings',
  )
  const firstRun = app.windows().find(w => w.url().includes('settings.html'))
  await firstRun.waitForSelector('#server-url', { timeout: 10_000 })
  await firstRun.fill('#server-url', SERVER)
  await firstRun.selectOption('#env-kind', 'production')
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

  // State hub reports the environment and connection.
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.environment?.url === SERVER && state?.connection?.state === 'connected'
  }, 20_000, 'desktop state connected')

  const initialState = await dashboard.evaluate(() => window.wombatApp.getShellState())
  assert.equal(initialState.environment.name.length > 0, true)
  assert.equal(initialState.environment.health, 'connected')
  assert.equal(initialState.environment.kind, 'production')
  assert.equal(typeof initialState.ui.locale, 'string')
  assert.ok(['dark', 'light'].includes(initialState.ui.effectiveTheme))

  // Live locale switch updates the app bar labels.
  await dashboard.evaluate(() => window.wombatApp.setLocale('en'))
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('[data-route="dashboard"]')?.textContent === 'Dashboard'
  }, null, { timeout: 10_000 })

  await dashboard.evaluate(() => window.wombatApp.setLocale('de'))
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('[data-route="dashboard"]')?.textContent === 'Übersicht'
  }, null, { timeout: 10_000 })

  // App bar ARIA and roving tabindex.
  const navState = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    const active = root.querySelector('[aria-current="page"]')
    const links = [...root.querySelectorAll('.link')]
    return {
      activeRoute: active?.dataset.route ?? '',
      tabIndexes: links.map(link => link.tabIndex),
      role: root.querySelector('.bar')?.getAttribute('role'),
      barClass: root.querySelector('.bar')?.className ?? '',
      paddingLeft: getComputedStyle(root.querySelector('.bar')).paddingLeft,
      platform: window.wombatApp.platform,
    }
  })
  await dashboard.evaluate(() => window.wombatApp.setLocale('en'))
  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('[data-route="dashboard"]')?.textContent === 'Dashboard'
  }, null, { timeout: 10_000 })

  const chipState = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    const context = root.querySelector('.chip.context')
    const account = root.querySelector('.chip.account')
    return {
      contextText: context.querySelector('.chip-name').textContent,
      contextClass: context.className,
      prodHidden: context.querySelector('.badge.prod').hidden,
      contextLabel: context.getAttribute('aria-label'),
      accountText: account.querySelector('.chip-name').textContent,
      accountLabel: account.getAttribute('aria-label'),
      healthDot: context.querySelector('.healthdot').className,
    }
  })
  assert.equal(chipState.contextText, 'Local Docker')
  assert.match(chipState.contextClass, /prod/)
  assert.equal(chipState.prodHidden, false)
  assert.match(chipState.contextLabel, /Environment/)
  assert.match(chipState.accountText, /Sign in/)
  assert.match(chipState.accountLabel, /Account/)
  assert.match(chipState.healthDot, /connected/)

  assert.equal(navState.activeRoute, 'dashboard')
  assert.equal(navState.role, 'navigation')
  assert.equal(navState.tabIndexes.filter(value => value === 0).length, 1)
  if (navState.platform === 'darwin') {
    assert.match(navState.barClass, /platform-darwin/)
    assert.match(navState.barClass, /native-chrome/)
    assert.equal(navState.paddingLeft, '84px')
  }

  await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    root.querySelector('[data-route="dashboard"]').focus()
  })
  await dashboard.keyboard.press('ArrowRight')
  const focusedRoute = await dashboard.evaluate(() => {
    const root = document.getElementById('wombat-appbar-host').shadowRoot
    return root.activeElement?.dataset.route ?? ''
  })
  assert.equal(focusedRoute, 'findings')

  // Theme switches apply to registered shell windows.
  await dashboard.evaluate(() => window.wombatApp.setTheme('light'))
  const settings = await openSettingsFromMenu(app)
  await settings.waitForFunction(
    () => document.documentElement.dataset.theme === 'light',
    null,
    { timeout: 10_000 },
  )
  const lightBackground = await settings.evaluate(() => getComputedStyle(document.body).backgroundColor)
  assert.equal(lightBackground, 'rgb(245, 247, 250)')

  await dashboard.evaluate(() => window.wombatApp.setTheme('dark'))
  await settings.waitForFunction(
    () => document.documentElement.dataset.theme === 'dark',
    null,
    { timeout: 10_000 },
  )
  const darkBackground = await settings.evaluate(() => getComputedStyle(document.body).backgroundColor)
  assert.equal(darkBackground, 'rgb(11, 15, 20)')

  // Settings reacts to a live locale change too.
  await dashboard.evaluate(() => window.wombatApp.setLocale('de'))
  await settings.waitForFunction(
    () => document.querySelector('h1')?.textContent === 'Server-Einstellungen',
    null,
    { timeout: 10_000 },
  )
  await dashboard.evaluate(() => window.wombatApp.setLocale('en'))
  await settings.waitForFunction(
    () => document.querySelector('h1')?.textContent === 'Server Settings',
    null,
    { timeout: 10_000 },
  )
  // Settings tabs: every panel is reachable and exposes its controls.
  for (const tab of ['signin', 'appearance', 'scans', 'advanced', 'connection']) {
    await settings.click(`.tab[data-tab="${tab}"]`)
    const visible = await settings.evaluate(name => {
      const button = document.querySelector(`.tab[data-tab="${name}"]`)
      const panel = document.querySelector(`.panel[data-panel="${name}"]`)
      return button.getAttribute('aria-selected') === 'true' && panel && !panel.hidden
    }, tab)
    assert.equal(visible, true, `${tab} tab should be active`)
  }
  await settings.click('.tab[data-tab="appearance"]')
  assert.equal(await settings.locator('#theme').isVisible(), true)
  assert.equal(await settings.locator('#locale').isVisible(), true)
  await settings.click('.tab[data-tab="connection"]')
  assert.equal(await settings.locator('#env-kind').inputValue(), 'production')

  // Add a staging environment from the UI, then switch back to local.
  await settings.click('#env-new')
  await settings.fill('#env-name', 'Staging')
  await settings.selectOption('#env-kind', 'staging')
  await settings.fill('#server-url', SERVER)
  await settings.click('#save')

  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.environment?.name === 'Staging' && state.environment.kind === 'staging'
  }, 20_000, 'staging environment active')

  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('.chip.context .chip-name')?.textContent === 'Staging'
  }, null, { timeout: 10_000 })

  await dashboard.evaluate(() => window.wombatApp.switchEnvironment('local'))
  await waitUntil(async () => {
    const state = await dashboard.evaluate(() => window.wombatApp.getShellState())
    return state?.environment?.id === 'local' && state.environment.kind === 'production'
  }, 20_000, 'local environment restored')

  await dashboard.waitForFunction(() => {
    const root = document.getElementById('wombat-appbar-host')?.shadowRoot
    return root?.querySelector('.chip.context .chip-name')?.textContent === 'Local Docker'
      && root?.querySelector('.chip.context .badge.prod')?.hidden === false
  }, null, { timeout: 10_000 })

  // Palette listbox semantics and localized labels.
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

  const paletteSemantics = await palette.evaluate(() => ({
    inputRole: document.getElementById('query').getAttribute('role'),
    listRole: document.getElementById('list').getAttribute('role'),
    expanded: document.getElementById('query').getAttribute('aria-expanded'),
    placeholder: document.getElementById('query').placeholder,
    navigate: document.getElementById('footer-navigate').textContent,
  }))
  assert.equal(paletteSemantics.inputRole, 'combobox')
  assert.equal(paletteSemantics.listRole, 'listbox')
  assert.equal(paletteSemantics.expanded, 'true')
  assert.match(paletteSemantics.placeholder, /Search runs/)
  assert.match(paletteSemantics.navigate, /navigate/)

  await palette.fill('#query', 'wombat')
  await palette.waitForFunction(
    () => document.querySelectorAll('.item[role="option"]').length > 0,
    null,
    { timeout: 10_000 },
  )
  await palette.waitForFunction(
    () => Boolean(document.querySelector('.item[role="option"][aria-selected="true"]')),
    null,
    { timeout: 10_000 },
  )
  const paletteState = await palette.evaluate(() => {
    const input = document.getElementById('query')
    const first = document.querySelector('.item[role="option"]')
    const selected = document.querySelector('.item[role="option"][aria-selected="true"]')
    return {
      firstRole: first.getAttribute('role'),
      selectedId: selected?.id ?? '',
      activeDescendant: input.getAttribute('aria-activedescendant'),
      live: document.getElementById('palette-live').textContent,
    }
  })
  assert.equal(paletteState.firstRole, 'option')
  assert.equal(paletteState.selectedId, paletteState.activeDescendant)
  assert.match(paletteState.live, /result/i)

  console.log(
    `ui foundations ok — state=${initialState.connection.state}, theme=${initialState.ui.effectiveTheme}, native=${navState.barClass}`,
  )
} finally {
  await app?.close().catch(() => {})
  await rm(USER_DATA, { recursive: true, force: true })
}
