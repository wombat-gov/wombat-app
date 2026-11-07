/**
 * macOS menu-bar controller: a status item with a frameless popover showing
 * the Service and Latest-scan widgets.
 *
 * Also owns the status-icon state, dock badge, menu-bar text, global
 * shortcuts, environment switching, Docker stack start and native
 * notifications (new findings + governance reminders).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'

import {
  getActiveEnvironment,
  getActiveEnvironmentId,
  getEnvironments,
  getPreferences,
  readConfig,
  savePreferences,
  writeConfig,
} from './config.js'
import { startDockerStack, waitForHealth } from './docker-stack.js'
import { createEventStream } from './events.js'
import { getLocale, getMessages, translate, tt } from './i18n.js'
import { getStateSnapshot, patchState } from './desktop-state.js'
import { applyScanEvent, refreshScanJobs } from './scan-state.js'
import { publishToast } from './toasts.js'
import { logger } from './logger.js'
import { registerShellWindow } from './theme.js'
import { SESSION_PARTITION } from './security.js'
import { collectWidgetData } from './widgets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WIDTH = 380
const HEIGHT = 680
const REFRESH_MS = 15_000
const DAY_MS = 24 * 60 * 60 * 1000

export function createTray({
  origin,
  showDashboard,
  openSettings,
  getContext,
  switchEnvironment,
  onCheckUpdates,
  actions = {},
  isWatching,
}) {
  const assetsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, 'assets')

  const trayNormal = nativeImage.createFromPath(path.join(assetsDir, 'tray.png'))
  const trayAlert = nativeImage.createFromPath(path.join(assetsDir, 'tray-alert.png'))
  const tray = new Tray(trayNormal.isEmpty() ? nativeImage.createEmpty() : trayNormal)
  tray.setToolTip('WOMBATpass Dashboard')
  tray.setIgnoreDoubleClickEvents(true)

  // The assets folder is shipped as an extraResource, not inside app.asar, so
  // the popover gets the mark as a data URI instead of a relative <img>.
  let brandIcon = ''
  try {
    brandIcon = `data:image/png;base64,${fs.readFileSync(path.join(assetsDir, 'tray@2x.png')).toString('base64')}`
  } catch (error) {
    logger.warn('tray icon asset', { message: error instanceof Error ? error.message : String(error) })
  }

  const locale = getLocale()
  const t = key => translate(locale, key)

  const popover = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'popover-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: SESSION_PARTITION,
    },
  })
  registerShellWindow(popover)
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  popover.loadFile(path.join(__dirname, 'popover.html'))

  let refreshTimer = null
  let lastHiddenAt = 0
  let inFlight = null
  let lastPayload = null
  let statusKey = ''
  let lastSeenRunId = null
  let governanceInitialized = false
  let stackBusy = false

  const withBrand = data => {
    const snapshot = getStateSnapshot()
    return {
      ...data,
      service: {
        ...data.service,
        environmentKind: snapshot.environment.kind || data.service?.environmentKind || 'local',
        auth: snapshot.auth,
      },
      brandIcon,
      locale,
      i18n: getMessages(),
    }
  }

  function dndActive() {
    const preferences = getPreferences()
    if (!preferences.dndEnabled) return false
    const minutes = (value) => {
      const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/)
      if (!match) return null
      return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]))
    }
    const start = minutes(preferences.dndStart)
    const end = minutes(preferences.dndEnd)
    if (start == null || end == null || start === end) return false
    const now = new Date()
    const current = now.getHours() * 60 + now.getMinutes()
    return start < end ? (current >= start && current < end) : (current >= start || current < end)
  }

  function notify(title, body, onClick) {
    if (!Notification.isSupported()) return
    if (dndActive()) return
    const notification = new Notification({ title, body })
    if (onClick) notification.on('click', onClick)
    notification.show()
  }

  function position() {
    const trayBounds = tray.getBounds()
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    const work = display.workArea
    const x = Math.round(Math.min(
      Math.max(trayBounds.x + trayBounds.width / 2 - WIDTH / 2, work.x + 8),
      work.x + work.width - WIDTH - 8,
    ))
    const y = Math.round(Math.min(
      Math.max(trayBounds.y + trayBounds.height + 6, work.y + 8),
      work.y + work.height - HEIGHT - 8,
    ))
    popover.setPosition(x, y, false)
  }

  function updateStatus(service) {
    const env = getActiveEnvironment()
    const ok = Boolean(service?.health?.ok)
    const key = `${ok}:${env?.id}:${env?.name}:${env?.kind || 'local'}`
    if (statusKey === key) return
    statusKey = key

    const image = ok ? trayNormal : trayAlert
    if (!image.isEmpty()) tray.setImage(image)
    tray.setToolTip(`WOMBATpass — ${env?.name ?? 'server'}${env?.kind === 'production' ? ' (PROD)' : ''} — ${ok ? 'healthy' : 'unreachable'}`)
  }

  function applyMenuBarText(data) {
    const mode = getPreferences().menuBarText
    let text = ''
    if (mode === 'score' && data.scan?.run?.score != null) text = String(data.scan.run.score)
    else if (mode === 'unread' && (data.notifications?.unread ?? 0) > 0) text = String(data.notifications.unread)
    tray.setTitle(text ? `  ${text}` : '')
  }

  function updateDockBadge(unread) {
    try {
      app.dock?.setBadge(unread > 0 ? String(unread) : '')
    } catch (error) {
      logger.warn('dock badge', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  function maybeNotifyFindings(scan) {
    const run = scan?.run
    if (!run) return

    if (lastSeenRunId === run.id) return
    const previous = lastSeenRunId
    lastSeenRunId = run.id

    // The first run seen after launch is the baseline, not "new".
    if (!previous) return
    if (!getPreferences().notifyFindings) return
    if ((run.critical ?? 0) + (run.high ?? 0) === 0) return
    if (BrowserWindow.getFocusedWindow()) return

    notify(
      tt('tray.newScanTitle', 'New scan: {project}', { project: run.project }),
      tt('tray.newScanBody', '{failed} failed controls · {critical} critical · {high} high · score {score}/100', {
        failed: run.failedControls, critical: run.critical, high: run.high, score: run.score ?? '—',
      }),
      () => openDashboard(run.id),
    )
    logger.info('notification shown', { run: run.id, project: run.project })
  }

  function maybeNotifyGovernance(data) {
    if (!getPreferences().notifyGovernance) return

    const config = readConfig()
    const now = Date.now()

    if (!governanceInitialized) {
      governanceInitialized = true
      if (config.lastExpiryNotify == null || config.lastDigestNotify == null) {
        writeConfig({ lastExpiryNotify: now, lastDigestNotify: now })
      }
      return
    }

    const governance = data.governance
    if (governance?.expiring > 0 && now - (config.lastExpiryNotify ?? 0) > DAY_MS) {
      writeConfig({ lastExpiryNotify: now })
      notify(
        tt('tray.governanceTitle', 'Governance reminders'),
        tt('tray.governanceBody', '{count} waiver(s) or risk acceptance(s) expire within 7 days.', { count: governance.expiring }),
        () => openDashboard(null, 'waivers'),
      )
    }

    const digest = data.scan?.digest
    if (digest?.runs24h > 0 && now - (config.lastDigestNotify ?? 0) > DAY_MS) {
      writeConfig({ lastDigestNotify: now })
      notify(
        tt('tray.digestTitle', 'WOMBATpass daily digest'),
        tt('tray.digestBody', '{runs} new scan(s) across {projects} project(s) in the last 24 hours.', { runs: digest.runs24h, projects: digest.projects24h }),
        () => openDashboard(null, 'runs'),
      )
    }
  }

  function pushData() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const context = typeof getContext === 'function' ? await getContext() : {}
      const data = await collectWidgetData(origin, context)
      const payload = withBrand(data)
      lastPayload = payload

      updateStatus(data.service)
      applyMenuBarText(data)
      updateDockBadge(data.notifications?.unread ?? 0)
      patchState({
        environment: {
          health: data.service?.health?.ok ? 'connected' : 'offline',
          latencyMs: data.service?.health?.latencyMs ?? null,
          lastSyncAt: data.generatedAt || new Date().toISOString(),
        },
        notifications: { unread: data.notifications?.unread ?? 0 },
      })
      maybeNotifyFindings(data.scan)
      maybeNotifyGovernance(data)

      if (!popover.isDestroyed()) popover.webContents.send('widgets:update', payload)
      return payload
    })()
      .catch((error) => {
        logger.error('widget data', { message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function showPopover() {
    position()
    popover.show()
    popover.focus()
    if (lastPayload && !popover.isDestroyed()) {
      popover.webContents.send('widgets:update', lastPayload)
    }
    pushData()
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(() => {
      if (popover.isVisible()) pushData()
    }, REFRESH_MS)
  }

  function hidePopover() {
    if (!popover.isVisible()) return
    popover.hide()
    lastHiddenAt = Date.now()
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  function togglePopover() {
    if (popover.isVisible()) hidePopover()
    else showPopover()
  }

  function openDashboard(runId = null, route = null) {
    hidePopover()
    showDashboard({ runId, route })
  }

  async function startStack() {
    if (stackBusy) return { ok: false, message: 'Already starting…' }
    stackBusy = true
    try {
      const result = await startDockerStack()
      if (!result.ok) {
        const message = result.error === 'no-path'
          ? 'Set the Docker Compose path in Server Settings.'
          : result.error === 'no-compose'
            ? 'No docker-compose.yml found in the configured path.'
            : result.error
        return { ok: false, message }
      }

      const healthy = await waitForHealth()
      logger.info('docker stack start finished', { healthy })
      notify(
        healthy ? 'WOMBAT stack started' : 'WOMBAT stack start timed out',
        healthy ? 'wombat-server is healthy.' : 'The stack was started but /health did not answer.',
      )
      pushData()
      return {
        ok: true,
        healthy,
        message: healthy ? 'Stack is up' : 'Started, but health check timed out',
      }
    } finally {
      stackBusy = false
    }
  }

  tray.on('click', () => {
    if (popover.isVisible()) {
      hidePopover()
      return
    }
    if (Date.now() - lastHiddenAt < 300) return
    showPopover()
  })

  popover.on('blur', () => {
    if (popover.webContents.isDevToolsOpened()) return
    hidePopover()
  })

  popover.webContents.on('render-process-gone', (_event, details) => {
    logger.error('popover renderer gone', details)
  })

  function buildContextMenu() {
    const environments = getEnvironments()
    const activeId = getActiveEnvironmentId()
    const preferences = getPreferences()
    const runId = lastPayload?.scan?.run?.id ?? null
    const watching = Boolean(isWatching?.())

    return Menu.buildFromTemplate([
      { label: t('menu.openDashboard'), click: () => openDashboard() },
      { label: t('menu.showWidgets'), accelerator: 'CmdOrCtrl+Shift+W', click: () => showPopover() },
      { label: t('menu.commandPalette'), accelerator: 'CmdOrCtrl+Shift+K', click: () => actions.palette?.() },
      { type: 'separator' },
      { label: t('menu.scanClipboard'), accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.scanClipboard?.() },
      { label: t('menu.scanFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: () => actions.scanFolder?.() },
      { label: t('menu.watchFolder'), click: () => actions.watchFolder?.() },
      { label: t('menu.stopWatching'), enabled: watching, click: () => actions.stopWatch?.() },
      { type: 'separator' },
      { label: t('menu.stackConsole'), click: () => actions.stack?.() },
      {
        label: t('menu.openInNewTab'),
        enabled: Boolean(runId),
        click: () => { if (runId) actions.openTab?.(runId) },
      },
      {
        label: t('menu.environments'),
        submenu: environments.map(environment => ({
          label: `${environment.name}${environment.kind === 'production' ? '  · PROD' : ''} — ${environment.url}`,
          type: 'radio',
          checked: environment.id === activeId,
          click: () => {
            const selected = switchEnvironment?.(environment.id)
            if (selected) {
              lastPayload = null
              statusKey = ''
              pushData()
            }
          },
        })),
      },
      {
        label: t('menu.startStack'),
        enabled: Boolean(preferences.dockerComposePath?.trim()),
        click: () => { startStack() },
      },
      { type: 'separator' },
      {
        label: t('appbar.manageDevices'),
        click: () => { hidePopover(); actions.manageDevices?.() },
      },
      {
        label: t('appbar.signInBrowser'),
        click: () => { hidePopover(); actions.signInDevice?.() },
      },
      {
        label: t('appbar.signOutDevice'),
        enabled: getStateSnapshot().auth?.method === 'device',
        click: () => { hidePopover(); actions.signOutDevice?.() },
      },
      { type: 'separator' },
      {
        label: t('menu.copyRunLink'),
        enabled: Boolean(runId),
        click: () => { if (runId) clipboard.writeText(`wombatpass://run/${runId}`).catch(() => {}) },
      },
      {
        label: t('menu.copyLastRunFindings'),
        enabled: Boolean(runId),
        click: () => { if (runId) openDashboard(runId, 'findings') },
      },
      { label: t('menu.refresh'), click: () => pushData() },
      { label: t('menu.checkUpdates'), click: () => onCheckUpdates?.() },
      { label: t('menu.help'), click: () => actions.help?.() },
      { type: 'separator' },
      { label: t('menu.settings'), click: () => { hidePopover(); openSettings() } },
      { label: t('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ])
  }
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()))

  // Keep tray status, dock badge and notifications alive even when the
  // popover is closed.
  const backgroundTimer = setInterval(() => { pushData() }, 60_000)
  setTimeout(() => { pushData() }, 1_500)

  // Live updates from the server (Wave A). The stream is optional: older
  // servers answer 404 and the 60 s poll above remains the fallback.
  let refreshTimerDebounce = null
  const refreshSoon = (delay = 300) => {
    if (refreshTimerDebounce) clearTimeout(refreshTimerDebounce)
    refreshTimerDebounce = setTimeout(() => {
      refreshTimerDebounce = null
      pushData()
    }, delay)
  }
  const eventStream = createEventStream({
    origin,
    getContext,
    onEvent: (event) => {
      if (event.event.startsWith('scan.')) {
        const result = applyScanEvent(event.event, event.data)
        if (result.refresh) refreshScanJobs(origin).catch(() => {})
        if (event.event === 'scan.completed' && event.data?.run_id) {
          publishToast({
            level: 'success',
            title: `Scan complete: ${event.data.project || 'run'}`,
            body: `Score ${event.data.score ?? '—'}/100`,
            action: { kind: 'run', id: event.data.run_id },
            key: `scan-complete:${event.data.run_id}`,
          })
        } else if (event.event === 'scan.failed') {
          publishToast({
            level: 'error',
            title: `Scan failed: ${event.data?.project || 'run'}`,
            body: String(event.data?.error || 'The scan could not be completed.'),
            key: `scan-failed:${event.data?.job_id || ''}`,
          })
        }
      }
      if (event.event === 'notification.created') {
        const category = String(event.data?.category || 'info')
        if (getPreferences().notifySystem !== false) {
          notify(String(event.data?.title || 'Notification'), '', () => openDashboard(null, 'notifications'))
        }
        if (getPreferences().notifySystem !== false) publishToast({
          level: category === 'urgent' || category === 'warning' ? 'warning' : 'info',
          title: String(event.data?.title || 'Notification'),
          body: '',
          action: { kind: 'route', route: 'notifications' },
          key: `notification:${event.data?.id || ''}`,
        })
      }
      if (
        event.event === 'run.created' ||
        event.event === 'run.updated' ||
        event.event === 'notification.created' ||
        event.event === 'notification.updated' ||
        event.event === 'waiver.changed' ||
        event.event === 'risk.changed' ||
        event.event === 'scan.completed'
      ) {
        logger.info('live event', { type: event.event })
        refreshSoon()
      }
    },
    onStatus: (status) => logger.info('event stream', { status }),
  })
  eventStream.start()

  ipcMain.handle('widgets:get', async () => {
    const context = typeof getContext === 'function' ? await getContext() : {}
    const data = await collectWidgetData(origin, context)
    lastPayload = withBrand(data)
    updateStatus(data.service)
    applyMenuBarText(data)
    updateDockBadge(data.notifications?.unread ?? 0)
    return lastPayload
  })

  ipcMain.handle('widgets:open-dashboard', (_event, arg) => {
    if (arg && typeof arg === 'object') {
      openDashboard(arg.runId ?? null, arg.route ?? null)
    } else {
      openDashboard(typeof arg === 'string' && arg ? arg : null)
    }
    return { ok: true }
  })
  ipcMain.handle('widgets:open-findings', (_event, runId) => {
    openDashboard(typeof runId === 'string' ? runId : null, 'findings')
    return { ok: true }
  })
  ipcMain.handle('widgets:open-notifications', () => {
    openDashboard(null, 'notifications')
    return { ok: true }
  })
  ipcMain.handle('widgets:copy-link', async (_event, runId) => {
    if (!runId) return { ok: false }
    await clipboard.writeText(`wombatpass://run/${runId}`)
    return { ok: true, link: `wombatpass://run/${runId}` }
  })
  ipcMain.handle('widgets:set-project', (_event, project) => {
    savePreferences({ widgetProject: typeof project === 'string' ? project : '' })
    pushData()
    return { ok: true }
  })
  ipcMain.handle('widgets:start-stack', () => startStack())
  ipcMain.handle('widgets:hide', () => {
    hidePopover()
    return { ok: true }
  })
  ipcMain.handle('widgets:open-settings', () => {
    hidePopover()
    openSettings()
    return { ok: true }
  })
  ipcMain.handle('widgets:quit', () => {
    app.quit()
    return { ok: true }
  })

  return {
    tray,
    popover,
    showPopover,
    hidePopover,
    togglePopover,
    pushData,
    destroy() {
      clearInterval(backgroundTimer)
      if (refreshTimer) clearInterval(refreshTimer)
      if (refreshTimerDebounce) clearTimeout(refreshTimerDebounce)
      try { eventStream.stop() } catch { /* ignore */ }
      popover.destroy()
      tray.destroy()
    },
  }
}
