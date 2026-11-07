/**
 * Electron main process.
 *
 * Boot order:
 *   1. start the loopback server (static dashboard + /api proxy)
 *   2. first run / unreachable: open Server Settings
 *   3. create the main BrowserWindow against the loopback origin (unless
 *      "start in menu bar" is enabled)
 *
 * The renderer is the unmodified dashboard build. It never gets Node access.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_TITLE,
  DEFAULT_PORT,
  DEFAULT_SERVER_URL,
  WINDOW_DEFAULTS,
  applyDockVisibility,
  applyLoginItem,
  getActiveEnvironment,
  getActiveEnvironmentId,
  getConfigPath,
  getDashboardDir,
  getEnvironments,
  getPreferences,
  getServerUrl,
  getWindowState,
  readConfig,
  saveEnvironments,
  savePreferences,
  saveWindowState,
  setActiveEnvironment,
  writeConfig,
} from './config.js'
import { appFetch } from './app-api.js'
import { parseArgv, parseDeepLink } from './deeplinks.js'
import { createDeviceAuth, getDeviceStatus, getStoredDeviceToken } from './device-auth.js'
import { formatDiagnostics, registerDiagnosticsIpc, saveDiagnostics } from './diagnostics.js'
import { getStateSnapshot, initDesktopState, patchState, refreshDesktopState, stopDesktopState } from './desktop-state.js'
import { detectServers } from './detect.js'
import { createHelp } from './help.js'
import { getLocale, getMessages, initI18n, setLocalePreference, tt } from './i18n.js'
import { getLogPath, initLogger, logger } from './logger.js'
import { buildMenu } from './menu.js'
import { registerOnboardingIpc } from './onboarding.js'
import { createPalette } from './palette.js'
import { createQuickScan } from './quick-scan.js'
import { createScanFolder } from './scan-folder.js'
import { getScanSummary, refreshScanJobs, setScanJobs, subscribeScanJobs } from './scan-state.js'
import { startServer } from './server.js'
import { registerShortcuts, unregisterShortcuts } from './shortcuts.js'
import { createStack } from './stack.js'
import { createTabs, customTabsEnabled } from './tabs.js'
import { getThemeState, initTheme, registerShellWindow, setThemeMode, stopTheme } from './theme.js'
import { createTray } from './tray.js'
import { publishToast } from './toasts.js'
import { checkForUpdates, openDownloadedUpdate, registerUpdateIpc } from './updates.js'
import {
  SESSION_PARTITION,
  attachNavigationGuards,
  configureSession,
  lockDownWebContents,
} from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.setName(APP_TITLE)
initLogger()
lockDownWebContents()

logger.info('app starting', {
  version: app.getVersion(),
  electron: process.versions.electron,
  locale: getLocale(),
})

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', { message: error.message, stack: error.stack })
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) })
})

// Set as soon as the app is asked to quit. The settings window's `closed`
// handler must not open the main window while the app is shutting down — that
// would create a new window and cancel the quit.
let isQuitting = false
app.on('before-quit', () => {
  isQuitting = true
  tabsController?.shutdown?.()
  deviceAuthController?.cancelAll()
})

let mainWindow = null
let settingsWindow = null
let settingsDirty = false
let localServer = null
let trayController = null
let stackController = null
let deviceAuthController = null
const runContextCache = new Map()
const perfMarks = new Map()

function markPerf(name) {
  if (perfMarks.has(name)) return
  perfMarks.set(name, {
    at: new Date().toISOString(),
    sinceProcessStartMs: Math.round(performance.now()),
  })
}
let lastCrash = null
let crashWindow = null
let tabsController = null
let startupSavedTabs = null
let startupSavedActiveIndex = 0
let lastScanTotal = 0
let updateTimer = null
let quickScanController = null
let paletteController = null
let scanController = null
let helpController = null

// ── Deep links ──────────────────────────────────────────────────────────────
const pendingLinks = []

function handleIncomingUrl(rawUrl) {
  const link = parseDeepLink(rawUrl)
  if (!link) return
  if (link.action === 'scan') {
    if (scanController) scanController.scanFolder(link.path)
    else pendingLinks.push(link)
    return
  }
  if (localServer && !isQuitting) navigateTo(link)
  else pendingLinks.push(link)
}

function navigateTo(link) {
  if (link.action === 'scan') return
  if (!localServer) {
    pendingLinks.push(link)
    return
  }
  logger.info('deep link', link)
  if (!mainWindow) createMainWindow(localServer.origin)
  if (!mainWindow) return

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  if (link.route) {
    const query = link.runId ? `?run=${encodeURIComponent(link.runId)}` : ''
    mainWindow.loadURL(`${localServer.origin}/#/${link.route}${query}`)
  } else if (link.runId) {
    mainWindow.loadURL(`${localServer.origin}/#/dashboard?run=${encodeURIComponent(link.runId)}`)
  }
}

// Register the URL scheme. In development registration is opt-in so it does not
// hijack wombatpass:// links for the Electron binary.
try {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('wombatpass')
  } else if (process.env.WOMBAT_REGISTER_PROTOCOL === '1') {
    app.setAsDefaultProtocolClient('wombatpass', process.execPath, [path.resolve(process.argv[1] ?? '.')])
  }
} catch (error) {
  logger.warn('protocol registration failed', { message: error instanceof Error ? error.message : String(error) })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleIncomingUrl(url)
})

// Folders dropped on the dock icon (macOS).
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  try {
    if (!fs.statSync(filePath).isDirectory()) return
  } catch {
    return
  }
  if (scanController) scanController.scanFolder(filePath)
  else pendingLinks.push({ action: 'scan', path: filePath })
})

for (const link of parseArgv(process.argv)) {
  pendingLinks.push(link)
}

async function getDashboardContext() {
  if (!mainWindow || mainWindow.isDestroyed()) return {}
  try {
    return await mainWindow.webContents.executeJavaScript(`(() => ({
      mandant: localStorage.getItem('wombat_mandant_context') || null,
    }))()`)
  } catch {
    return {}
  }
}

function switchEnvironment(id) {
  const environment = setActiveEnvironment(id)
  if (!environment) return null

  logger.info('environment switched', { id, url: environment.url })
  runContextCache.clear()
  setScanJobs([])
  broadcastScanJobs()
  refreshScanJobs(localServer?.origin ?? '').then(() => broadcastScanJobs()).catch(() => {})
  refreshDesktopState().catch(() => {})
  // The project filter belongs to the environment.
  savePreferences({ widgetProject: '' })
  // The desktop app owns the backend selection; drop the dashboard's own
  // server-URL override so the proxy stays authoritative.
  try {
    mainWindow?.webContents.executeJavaScript("localStorage.removeItem('wombat_server_url')")
  } catch {
    /* ignore */
  }
  mainWindow?.webContents.reload()
  return environment
}

function flushPendingLinks() {
  if (pendingLinks.length === 0) return
  const links = pendingLinks.splice(0)
  setTimeout(() => {
    for (const link of links) {
      if (link.action === 'scan') scanController?.scanFolder(link.path)
      else navigateTo(link)
    }
  }, 1_200)
}

// ── Native window chrome (Wave U0 spike, flag-controlled) ───────────────────
function nativeChromeEnabled() {
  if (process.env.WOMBAT_NATIVE_CHROME === '0') return false
  if (getPreferences().nativeChrome === false) return false
  return process.platform === 'darwin' || process.platform === 'win32'
}

function applyDashboardZoom(win) {
  if (!win || win.isDestroyed()) return
  const factor = Math.max(0.8, Math.min(1.5, Number(getPreferences().zoomFactor) || 1))
  try {
    win.webContents.setZoomFactor(factor)
  } catch {
    /* webContents may not be ready yet */
  }
}

function nativeChromeOptions() {
  if (!nativeChromeEnabled()) return {}
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
    }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0b0f14', symbolColor: '#e6edf5', height: 38 },
    }
  }
  return {}
}

// ── Additional windows ──────────────────────────────────────────────────────
function openDashboardWindow({ runId = null, route = null, dedupe = true } = {}) {
  if (!localServer) return null

  const query = runId ? `?run=${encodeURIComponent(runId)}` : ''
  const safeRoute = route ? String(route).replace(/[^a-z0-9/_-]/gi, '') : ''
  const hash = safeRoute ? `#/${safeRoute}${query}` : runId ? `#/dashboard${query}` : ''
  const useCustomTabs = customTabsEnabled()

  if (useCustomTabs && dedupe && runId && tabsController?.enabled) {
    const existing = tabsController.getTabs().find(tab => tab.runId === String(runId))
    if (existing) {
      tabsController.activate(existing.id)
      return existing.win
    }
  }

  const win = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    ...nativeChromeOptions(),
    title: APP_TITLE,
    show: false,
    // macOS native tabs when the custom tab strip is disabled.
    ...(useCustomTabs ? {} : { tabbingIdentifier: 'wombat-dashboard' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: SESSION_PARTITION,
      additionalArguments: [
        nativeChromeEnabled() ? '--wombat-native-chrome=1' : '--wombat-native-chrome=0',
      ],
    },
  })

  let tabId = null
  if (useCustomTabs && tabsController?.enabled) {
    tabId = tabsController.register(win, {
      route: safeRoute || 'dashboard',
      runId,
      title: runId ? 'Run' : (safeRoute || 'Dashboard'),
    })
  }
  win.once('ready-to-show', () => {
    if (tabId) tabsController?.activate(tabId)
    else win.show()
  })
  configureSession(win.webContents.session, localServer.origin)
  attachNavigationGuards(win, localServer.origin)
  applyDashboardZoom(win)

  let tabCrashes = 0
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('tab renderer gone', { tab: tabId, ...details })
    tabCrashes += 1
    const limit = Number.parseInt(process.env.WOMBAT_CRASH_RETRY_LIMIT ?? '3', 10)
    const retryLimit = Number.isFinite(limit) ? Math.max(0, limit) : 3
    if (tabCrashes <= retryLimit && !win.isDestroyed()) {
      win.reload()
      return
    }
    publishToast({
      level: 'error',
      title: tt('toast.tabCrashedTitle', 'Tab stopped'),
      body: tt('toast.tabCrashedBody', 'The tab crashed repeatedly and was closed.'),
      key: `tab-crash:${tabId || 'window'}`,
    })
    if (tabId) tabsController?.close(tabId)
    else if (!win.isDestroyed()) showCrashPage(win, details)
  })

  win.loadURL(`${localServer.origin}/${hash}`)
  return win
}

// ── Print / PDF ─────────────────────────────────────────────────────────────
function activeWindow() {
  return BrowserWindow.getFocusedWindow() ?? mainWindow
}

function printPage() {
  const win = activeWindow()
  if (!win) return
  win.webContents.print({ printBackground: true })
}

async function savePageAsPdf() {
  const win = activeWindow()
  if (!win) return

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save page as PDF',
    defaultPath: path.join(app.getPath('documents'), 'WOMBATpass.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return

  try {
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await fs.promises.writeFile(filePath, data)
    shell.showItemInFolder(filePath)
    logger.info('page saved as pdf', { filePath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('pdf export failed', { message })
    dialog.showErrorBox('PDF export failed', message)
  }
}

// ── Palette commands / tray actions ─────────────────────────────────────────
const PALETTE_ACTIONS = [
  { id: 'open-dashboard', label: 'Open Dashboard' },
  { id: 'new-window', label: 'Open Dashboard in New Window' },
  { id: 'palette', label: 'Command Palette' },
  { id: 'stack', label: 'Stack Console' },
  { id: 'scan-clipboard', label: 'Scan Clipboard (IaC)' },
  { id: 'scan-folder', label: 'Scan Folder…' },
  { id: 'watch-folder', label: 'Watch Folder…' },
  { id: 'stop-watch', label: 'Stop Watching' },
  { id: 'settings', label: 'Server Settings…' },
  { id: 'help', label: 'Help & About' },
  { id: 'logs', label: 'Show Logs' },
  { id: 'start-stack', label: 'Start Docker Stack' },
  { id: 'check-updates', label: 'Check for Updates…' },
  { id: 'print', label: 'Print Page…' },
  { id: 'pdf', label: 'Save Page as PDF…' },
  { id: 'manage-devices', label: 'Manage Devices…' },
  { id: 'sign-in-browser', label: 'Sign in with Browser…' },
  { id: 'sign-out-device', label: 'Sign Out Device' },
  { id: 'open-notifications', label: 'Open Notifications' },
  { id: 'theme-system', label: 'Theme: System' },
  { id: 'theme-light', label: 'Theme: Light' },
  { id: 'theme-dark', label: 'Theme: Dark' },
  { id: 'refresh-state', label: 'Refresh Connection' },
]

function paletteActions() {
  const messages = getMessages()
  return PALETTE_ACTIONS.map(action => ({
    id: action.id,
    label: messages[`action.${action.id}`] ?? action.label,
  }))
}

function runAction(id) {
  switch (id) {
    case 'open-dashboard': navigateTo({ route: 'dashboard' }); break
    case 'new-window': openDashboardWindow({}); break
    case 'palette': paletteController?.open(); break
    case 'stack': stackController?.open(); break
    case 'scan-clipboard': quickScanController?.scanClipboard(); break
    case 'scan-folder': scanController?.open(); break
    case 'watch-folder': scanController?.chooseWatch(); break
    case 'stop-watch': scanController?.stopWatching(); break
    case 'settings': createSettingsWindow(); break
    case 'help': helpController?.open(); break
    case 'help-shortcuts': helpController?.open('shortcuts'); break
    case 'logs': {
      const logPath = getLogPath()
      if (logPath) shell.showItemInFolder(logPath)
      break
    }
    case 'start-stack': stackController?.startStack(); break
    case 'check-updates':
      checkForUpdates().then(() => createSettingsWindow({ tab: 'advanced' })).catch(() => {})
      break
    case 'open-updates': createSettingsWindow({ tab: 'advanced' }); break
    case 'print': printPage(); break
    case 'pdf': savePageAsPdf(); break
    case 'manage-devices': createSettingsWindow({ tab: 'signin' }); break
    case 'sign-in-browser': signInFromAppBar(); break
    case 'sign-out-device': signOutFromAppBar(); break
    case 'open-notifications': navigateTo({ route: 'notifications' }); break
    case 'theme-system': setThemeMode('system'); break
    case 'theme-light': setThemeMode('light'); break
    case 'theme-dark': setThemeMode('dark'); break
    case 'refresh-state':
      refreshDesktopState()
        .then(() => publishToast({ level: 'success', title: tt('toast.connectionRefreshed', 'Connection refreshed'), key: 'refresh-state' }))
        .catch(() => {})
      break
    default: break
  }
}

function handlePaletteCommand(command) {
  switch (command.kind) {
    case 'run': navigateTo({ runId: command.id }); break
    case 'page': navigateTo({ route: command.route }); break
    case 'control': navigateTo({ route: 'catalogue' }); break
    case 'finding': navigateTo({ route: 'findings', runId: command.runId }); break
    case 'environment':
      switchEnvironment(command.id)
      trayController?.pushData()
      break
    case 'action': runAction(command.id); break
    default: break
  }
}

function handleProxyResponse(status, pathname) {
  const path = String(pathname ?? '')
  if (path === '/api/v1/auth/logout' && status < 400) {
    patchState({ auth: { signedIn: false, expired: false, method: 'none', user: null } })
    return
  }
  if (status !== 401) return
  if (!path.startsWith('/api/')) return
  if (/^\/api\/v1\/auth\/(login|refresh|logout|device|oidc|saml|sso)/.test(path)) return
  const state = getStateSnapshot()
  if (!state.auth.signedIn && !state.auth.expired) return
  patchState({ auth: { signedIn: false, expired: true } })
}

function scanPayload() {
  const summary = getScanSummary()
  return {
    ok: true,
    jobs: summary.jobs,
    running: summary.running,
    failed: summary.failed,
    total: lastScanTotal,
    watching: getStateSnapshot().scan.watching,
  }
}

function broadcastScanJobs() {
  const payload = scanPayload()
  patchState({ scan: { jobs: payload.jobs, running: payload.running } })
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    const active = payload.jobs.filter(job => job.status === 'queued' || job.status === 'running')
    if (active.length) {
      const progress = active.reduce((sum, job) => sum + (Number(job.progress) || 0), 0) / (active.length * 100)
      try { mainWindow.setProgressBar(Math.max(0.01, Math.min(1, progress)), { mode: 'normal' }) } catch { /* ignore */ }
    } else {
      try { mainWindow.setProgressBar(-1) } catch { /* ignore */ }
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('scan:jobs', payload)
    } catch {
      /* window is going away */
    }
  }
}

function registerAppActionIpc() {
  ipcMain.handle('appbar:action', (_event, action) => {
    runAction(String(action ?? ''))
    return { ok: true }
  })
  ipcMain.handle('widgets:open-stack', () => {
    stackController?.open()
    return { ok: true }
  })
  ipcMain.handle('widgets:open-tab', (_event, runId) => {
    openDashboardWindow({ runId: typeof runId === 'string' ? runId : null })
    return { ok: true }
  })
  ipcMain.handle('run:context', async (_event, runId) => {
    const id = String(runId ?? '')
    const origin = localServer?.origin
    if (!origin || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: 'Unknown run.' }

    const cached = runContextCache.get(id)
    if (cached && Date.now() - cached.at < 60_000) return { ok: true, run: cached.run }

    try {
      const response = await appFetch(origin, `/api/v1/runs/${encodeURIComponent(id)}`)
      if (response.status === 401) return { ok: false, signedIn: false, message: 'Sign in to load run details.' }
      if (response.status === 404) return { ok: false, missing: true, message: 'Run not found.' }
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      const json = await response.json()
      const data = json.data ?? json
      const run = {
        id: String(data.id ?? id),
        project: String(data.project ?? ''),
        branch: String(data.branch ?? ''),
        stage: String(data.stage ?? ''),
        score: typeof data.score === 'number' ? data.score : null,
        createdAt: data.created_at ?? null,
        completedAt: data.completed_at ?? null,
      }
      runContextCache.set(id, { at: Date.now(), run })
      return { ok: true, run }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('run:action', async (_event, payload) => {
    const action = String(payload?.action ?? '')
    const runId = String(payload?.runId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false }
    if (action === 'copy') {
      await clipboard.writeText(`wombatpass://run/${runId}`)
      publishToast({ level: 'info', title: tt('toast.runLinkCopiedTitle', 'Run link copied'), body: `wombatpass://run/${runId}`, key: `copy-run:${runId}` })
      return { ok: true }
    }
    if (action === 'window') {
      openDashboardWindow({ runId })
      return { ok: true }
    }
    if (action === 'findings') {
      navigateTo({ route: 'findings', runId })
      return { ok: true }
    }
    if (action === 'compare') {
      navigateTo({ route: 'diff', runId })
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('scan:jobs', async (_event, options) => {
    const origin = localServer?.origin ?? ''
    if (origin) {
      const result = await refreshScanJobs(origin, {
        limit: Number(options?.limit) || 20,
        status: options?.status ? String(options.status) : '',
      })
      lastScanTotal = Number(result.total) || 0
      broadcastScanJobs()
      return { ...scanPayload(), supported: result.supported, message: result.message, signedIn: result.signedIn }
    }
    return scanPayload()
  })

  ipcMain.handle('scan:refresh', async (_event, options) => {
    const origin = localServer?.origin ?? ''
    if (!origin) return scanPayload()
    const result = await refreshScanJobs(origin, {
      limit: Number(options?.limit) || 20,
      status: options?.status ? String(options.status) : '',
    })
    lastScanTotal = Number(result.total) || 0
    broadcastScanJobs()
    return { ...scanPayload(), supported: result.supported, message: result.message, signedIn: result.signedIn }
  })

  ipcMain.handle('scan:retry', async (_event, jobId) => {
    const origin = localServer?.origin
    const id = String(jobId ?? '')
    if (!origin || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: 'Unknown scan job.' }
    try {
      const response = await appFetch(origin, `/api/v1/scans/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return { ok: false, message: body.detail ?? `HTTP ${response.status}` }
      }
      const result = await refreshScanJobs(origin, { limit: 20 })
      lastScanTotal = Number(result.total) || 0
      broadcastScanJobs()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('scan:cancel-all', async () => {
    const origin = localServer?.origin
    if (!origin) return { ok: false }
    try {
      const listing = await appFetch(origin, '/api/v1/scans?limit=100')
      if (!listing.ok) return { ok: false, message: `HTTP ${listing.status}` }
      const json = await listing.json()
      const active = (Array.isArray(json.data) ? json.data : [])
        .filter(job => job.status === 'queued' || job.status === 'running')
      let cancelled = 0
      for (const job of active) {
        const response = await appFetch(origin, `/api/v1/scans/${encodeURIComponent(job.id)}/cancel`, {
          method: 'POST',
        })
        if (response.ok) cancelled += 1
      }
      const result = await refreshScanJobs(origin, { limit: 20 })
      lastScanTotal = Number(result.total) || 0
      broadcastScanJobs()
      return { ok: true, cancelled }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('shell:perf-mark', (_event, name) => {
    markPerf(String(name || 'unknown'))
    return { ok: true }
  })

  ipcMain.handle('perf:get', () => Object.fromEntries(perfMarks))

  ipcMain.handle('auth:recover', async () => {
    const environment = getActiveEnvironment()
    if (!environment) return { ok: false }
    const device = getDeviceStatus(environment.id, environment.url)
    if (device.signedIn) {
      await signInFromAppBar()
      return { ok: true, method: 'device' }
    }
    navigateTo({ route: 'login' })
    return { ok: true, method: 'cookie' }
  })

  ipcMain.handle('notifications:list', async (_event, options) => {
    const origin = localServer?.origin
    if (!origin) return { ok: false, message: 'The local server is not ready.' }
    try {
      const limit = Math.min(100, Math.max(1, Number(options?.limit) || 20))
      const offset = Math.max(0, Number(options?.offset) || 0)
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (options?.unreadOnly) params.set('unread_only', 'true')
      if (options?.category) params.set('category', String(options.category))
      const response = await appFetch(origin, `/api/v1/notifications?${params}`)
      if (response.status === 401) return { ok: false, signedIn: false, message: 'Sign in to see notifications.' }
      if (response.status === 403) return { ok: false, adminOnly: true, message: 'Notifications are not available for this account.' }
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      const json = await response.json()
      const items = (Array.isArray(json.data) ? json.data : []).map(item => ({
        id: String(item.id),
        title: String(item.title ?? ''),
        message: String(item.message ?? ''),
        category: String(item.category ?? 'info'),
        is_read: Boolean(item.is_read),
        created_at: item.created_at ?? null,
        link_route: String(item.link_route ?? ''),
        link_run_id: item.link_run_id ? String(item.link_run_id) : null,
        link_url: String(item.link_url ?? ''),
        project: String(item.project ?? ''),
      }))
      if (offset === 0 && !options?.unreadOnly && !options?.category) {
        patchState({ notifications: { unread: items.filter(item => !item.is_read).length } })
      }
      return { ok: true, items, total: Number(json.meta?.total ?? items.length), offset, limit }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('notifications:mark-read', async (_event, notificationId) => {
    const origin = localServer?.origin
    const id = String(notificationId ?? '')
    if (!origin || !id) return { ok: false }
    try {
      const response = await appFetch(origin, `/api/v1/notifications/${encodeURIComponent(id)}/read`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_read: true }),
      })
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      trayController?.pushData?.()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('notifications:open', (_event, payload) => {
    const route = String(payload?.route ?? 'notifications').replace(/[^a-z0-9/_-]/gi, '') || 'notifications'
    const runId = payload?.runId ? String(payload.runId) : null
    if (payload?.url && /^https?:\/\//i.test(String(payload.url))) {
      shell.openExternal(String(payload.url)).catch(() => {})
    }
    navigateTo({ route, runId })
    return { ok: true }
  })

  ipcMain.handle('notifications:mark-all', async () => {
    const origin = localServer?.origin
    if (!origin) return { ok: false }
    try {
      const response = await appFetch(origin, '/api/v1/notifications/read-all', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      patchState({ notifications: { unread: 0 } })
      trayController?.pushData?.()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('toast:action', (_event, action) => {
    if (!action || typeof action !== 'object') return { ok: false }
    if (action.kind === 'run' && action.id) navigateTo({ runId: String(action.id) })
    else if (action.kind === 'route' && action.route) navigateTo({ route: String(action.route) })
    else if (action.kind === 'settings') createSettingsWindow({ tab: action.tab ? String(action.tab) : null })
    else if (action.kind === 'update-open') openDownloadedUpdate().catch(() => {})
    else if (action.kind === 'reopen-tab') openDashboardWindow({ route: action.route, runId: action.runId })
    return { ok: true }
  })

  ipcMain.handle('widgets:start-drag', (event, runId) => {
    if (!runId) return { ok: false }

    const link = `wombatpass://run/${runId}`
    const extension = process.platform === 'darwin' ? 'webloc' : 'url'
    const file = path.join(app.getPath('temp'), `WOMBATpass-${String(runId).slice(0, 8)}.${extension}`)
    const body = process.platform === 'darwin'
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${link}</string></dict></plist>\n`
      : `[InternetShortcut]\nURL=${link}\n`

    try {
      fs.writeFileSync(file, body)
      const icon = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'tray@2x.png')
        : path.join(__dirname, 'assets', 'tray@2x.png')
      event.sender.startDrag({ file, icon })
      return { ok: true }
    } catch (error) {
      logger.warn('start drag failed', { message: error instanceof Error ? error.message : String(error) })
      return { ok: false }
    }
  })
}

function handleFatal(error) {
  const message = error instanceof Error ? error.message : String(error)
  logger.error('fatal', { message, stack: error instanceof Error ? error.stack : undefined })
  dialog.showErrorBox(`${APP_TITLE} could not start`, message)
  app.quit()
}

// ── Server-URL validation ───────────────────────────────────────────────────
function normalizeServerUrl(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  return trimmed
}

async function probeHealth(url) {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2_500),
    })
    return response.ok
  } catch {
    return false
  }
}

// ── Window state ────────────────────────────────────────────────────────────
function restoreWindowBounds() {
  const saved = getWindowState()
  if (!saved) return {}
  if (![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return {}

  const width = Math.max(WINDOW_DEFAULTS.minWidth, Math.min(saved.width, 10_000))
  const height = Math.max(WINDOW_DEFAULTS.minHeight, Math.min(saved.height, 10_000))
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(saved.x + width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x)
    const overlapY = Math.min(saved.y + height, workArea.y + workArea.height) - Math.max(saved.y, workArea.y)
    return overlapX >= 120 && overlapY >= 80
  })
  return visible ? { x: saved.x, y: saved.y, width, height } : { width, height }
}

function rememberWindowState(win) {
  try {
    const maximized = win.isMaximized()
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    saveWindowState({ ...bounds, maximized })
  } catch (error) {
    logger.warn('could not save window state', { message: error.message })
  }
}

function startUpdateScheduler() {
  const tick = () => {
    const preferences = getPreferences()
    const interval = preferences.updateCheckInterval
    if (!['daily', 'weekly'].includes(interval)) return
    const last = preferences.updateLastChecked ? new Date(preferences.updateLastChecked).getTime() : 0
    const period = interval === 'weekly' ? 7 * 86_400_000 : 86_400_000
    if (Date.now() - last < period) return
    checkForUpdates({ silent: true }).catch(() => {})
  }
  tick()
  updateTimer = setInterval(tick, 3_600_000)
  updateTimer.unref?.()
}

function restoreSavedTabs() {
  if (!tabsController?.enabled || !mainWindow || !getPreferences().restoreTabs) return
  const saved = startupSavedTabs ?? readConfig().openTabs
  if (!Array.isArray(saved) || saved.length === 0) return
  const first = saved[0]
  if (first?.route || first?.runId) {
    navigateTo({ route: first.route || 'dashboard', runId: first.runId || null })
  }
  for (const entry of saved.slice(1, 8)) {
    openDashboardWindow({ runId: entry.runId ?? null, route: entry.route ?? null })
  }
  // Extra windows activate on ready-to-show; defer the saved-active restore so
  // a late ready event cannot steal focus from the intended tab.
  setTimeout(() => {
    const current = tabsController.getTabs()
    const target = current[Math.min(Math.max(0, startupSavedActiveIndex), current.length - 1)]
    if (target) tabsController.activate(target.id)
  }, 1_200)
}

function recordCrashLoop() {
  const config = readConfig()
  const now = Date.now()
  const last = config.crashLoopAt ? new Date(config.crashLoopAt).getTime() : 0
  const recent = Number.isFinite(last) && now - last < 5 * 60_000
  const count = recent ? Number(config.crashLoopCount || 0) + 1 : 1
  writeConfig({ crashLoopCount: count, crashLoopAt: new Date(now).toISOString() })
  return count
}

// ── Crash recovery (UI Wave U4) ─────────────────────────────────────────────
function showCrashPage(win, details = {}) {
  lastCrash = {
    reason: String(details.reason ?? 'unknown'),
    exitCode: details.exitCode ?? null,
    at: new Date().toISOString(),
  }
  logger.error('showing crash page', lastCrash)
  try {
    if (getPreferences().crashReports) {
      const dir = path.join(app.getPath('userData'), 'crash-reports')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `crash-${Date.now()}.json`),
        formatDiagnostics({ crash: lastCrash }),
        'utf8',
      )
    }
  } catch (error) {
    logger.warn('crash report write', { message: String(error) })
  }

  // A crashed webContents cannot always be reused by Playwright or the
  // renderer; move recovery into a fresh window with the same partition.
  try {
    if (win && !win.isDestroyed()) {
      win.hide()
      win.destroy()
    }
  } catch {
    /* already gone */
  }
  if (crashWindow && !crashWindow.isDestroyed()) {
    crashWindow.show()
    crashWindow.focus()
    return
  }

  crashWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: `${APP_TITLE} — stopped`,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: SESSION_PARTITION,
      additionalArguments: [
        nativeChromeEnabled() ? '--wombat-native-chrome=1' : '--wombat-native-chrome=0',
      ],
    },
  })
  mainWindow = crashWindow
  crashWindow.once('ready-to-show', () => crashWindow.show())
  crashWindow.on('closed', () => {
    if (mainWindow === crashWindow) mainWindow = null
    crashWindow = null
  })
  if (localServer) {
    configureSession(crashWindow.webContents.session, localServer.origin)
    attachNavigationGuards(crashWindow, localServer.origin)
  }
  crashWindow.loadFile(path.join(__dirname, 'crash.html')).catch((error) => {
    logger.error('crash page load failed', { message: String(error) })
  })
}

function registerCrashIpc() {
  ipcMain.handle('crash:get', () => ({
    ok: true,
    crash: lastCrash,
    appVersion: app.getVersion(),
    logPath: getLogPath(),
    configPath: getConfigPath(),
  }))
  ipcMain.handle('crash:reload', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !localServer) return { ok: false }
    mainWindow = win
    win.loadURL(localServer.origin)
    return { ok: true }
  })
  ipcMain.handle('crash:reload-safe', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !localServer) return { ok: false }
    mainWindow = win
    win.loadURL(`${localServer.origin}/?safe=1#/dashboard`)
    return { ok: true }
  })
  ipcMain.handle('crash:open-logs', () => {
    const logPath = getLogPath()
    if (logPath) shell.showItemInFolder(logPath)
    return { ok: Boolean(logPath) }
  })
  ipcMain.handle('crash:copy-diagnostics', async () => {
    await clipboard.writeText(formatDiagnostics({ crash: lastCrash }))
    return { ok: true }
  })
  ipcMain.handle('crash:save-diagnostics', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    return saveDiagnostics(owner, { crash: lastCrash })
  })
  ipcMain.handle('crash:quit', () => {
    app.quit()
    return { ok: true }
  })
}

// ── Windows ─────────────────────────────────────────────────────────────────
function createMainWindow(origin) {
  const win = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    ...restoreWindowBounds(),
    ...nativeChromeOptions(),
    title: APP_TITLE,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Persistent, app-private session: cookies and localStorage survive
      // restarts and never mix with other Electron apps.
      partition: SESSION_PARTITION,
    },
  })

  const saved = getWindowState()
  if (saved?.maximized) win.maximize()

  const tabId = tabsController?.enabled
    ? tabsController.register(win, { route: 'dashboard', title: 'Dashboard' })
    : null
  win.once('ready-to-show', () => {
    if (tabId) tabsController?.activate(tabId)
    else win.show()
  })
  win.on('close', () => rememberWindowState(win))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  let crashes = 0
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer process gone', details)
    crashes += 1
    const limit = Number.parseInt(process.env.WOMBAT_CRASH_RETRY_LIMIT ?? '3', 10)
    const retryLimit = Number.isFinite(limit) ? Math.max(0, limit) : 3
    const persistentCrashes = recordCrashLoop()
    if (crashes <= retryLimit && persistentCrashes <= 3 && !win.isDestroyed()) {
      win.reload()
    } else {
      showCrashPage(win, details)
    }
  })

  configureSession(win.webContents.session, origin)
  attachNavigationGuards(win, origin)
  applyDashboardZoom(win)
  logger.info('main window created', {
    session: win.webContents.session.storagePath || 'in-memory',
  })

  win.loadURL(origin)
  mainWindow = win
  markPerf('dashboard-window-created')
  return win
}

function createSettingsWindow({ firstRun = false, tab = null } = {}) {
  if (settingsWindow) {
    settingsWindow.focus()
    if (tab) settingsWindow.webContents.send('settings:open-tab', tab)
    return
  }
  settingsDirty = false

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 860,
    minWidth: 640,
    minHeight: 620,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Server Settings',
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    show: false,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  registerShellWindow(settingsWindow)
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('close', (event) => {
    if (isQuitting || !settingsDirty || !settingsWindow) return
    event.preventDefault()
    const win = settingsWindow
    const messages = getMessages()
    dialog.showMessageBox(win, {
      type: 'warning',
      message: messages['settings.discardTitle'] ?? 'Discard unsaved settings?',
      detail: messages['settings.discardDetail'] ?? 'Your changes have not been applied.',
      buttons: ['Cancel', messages['settings.discard'] ?? 'Discard'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response !== 1 || !settingsWindow) return
      settingsDirty = false
      settingsWindow.close()
    }).catch(() => {})
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
    deviceAuthController?.cancelAll()
    // First run: whatever the user decided, make sure the app window appears —
    // unless the whole app is quitting.
    if (firstRun && !mainWindow && localServer && !isQuitting) {
      createMainWindow(localServer.origin)
      flushPendingLinks()
    }
  })

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'), tab ? { query: { tab } } : undefined)
  if (tab) {
    settingsWindow.webContents.once('did-finish-load', () => {
      settingsWindow?.webContents.send('settings:open-tab', tab)
    })
  }
}

// ── App-bar context and account menus (UI Wave U1) ──────────────────────────
function healthLabel(state, t) {
  const health = state?.environment?.health || 'unknown'
  return t(`appbar.health.${health}`, {
    connected: 'Connected',
    degraded: 'Degraded',
    offline: 'Offline',
    unknown: 'Checking…',
  }[health] || health)
}

async function testActiveEnvironmentConnection() {
  const environment = getActiveEnvironment()
  if (!environment) return
  const started = performance.now()
  try {
    const response = await fetch(`${environment.url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    const latency = Math.round(performance.now() - started)
    const body = await response.json().catch(() => ({}))
    await dialog.showMessageBox({
      type: response.ok ? 'info' : 'error',
      message: `${response.ok ? 'Connected' : 'Connection failed'} — ${environment.name}`,
      detail: response.ok
        ? `HTTP ${response.status} · ${latency} ms · ${String(body.status ?? 'ok')}`
        : `HTTP ${response.status} ${response.statusText}`,
      buttons: ['OK'],
      noLink: true,
    })
  } catch (error) {
    dialog.showErrorBox(
      `Connection failed — ${environment.name}`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function signInFromAppBar() {
  const environment = getActiveEnvironment()
  if (!environment || !deviceAuthController) return
  const platformName = process.platform === 'darwin' ? 'macOS' : process.platform
  const result = await deviceAuthController.signIn({
    environmentId: environment.id,
    url: environment.url,
    deviceName: `WOMBATpass Desktop (${platformName})`,
  })
  if (result.ok) {
    await refreshDesktopState().catch(() => {})
  } else if (!result.cancelled) {
    dialog.showErrorBox('Device sign-in', result.message || 'Sign-in failed.')
  }
}

async function signOutFromAppBar() {
  const environment = getActiveEnvironment()
  if (!environment || !deviceAuthController) return
  const production = environment.kind === 'production'
  const { response } = await dialog.showMessageBox({
    type: production ? 'error' : 'warning',
    message: `Sign out this device from ${environment.name}?`,
    detail: production
      ? 'This is the PRODUCTION environment. The revocable device token will stop working immediately.'
      : 'The revocable device token will stop working immediately. The browser session is not affected.',
    buttons: ['Cancel', 'Sign out'],
    defaultId: production ? 0 : 1,
    cancelId: 0,
    noLink: true,
  })
  if (response !== 1) return

  const result = await deviceAuthController.signOut({
    environmentId: environment.id,
    url: environment.url,
  })
  await refreshDesktopState().catch(() => {})
  mainWindow?.webContents.reload()
  trayController?.pushData?.()
  if (!result.ok) dialog.showErrorBox('Device sign-out', result.message || 'Sign-out failed.')
}

function registerAppBarMenus() {
  ipcMain.handle('shell:dashboard-theme', (event, payload) => {
    if (process.platform !== 'win32' || !nativeChromeEnabled()) return { ok: false }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return { ok: false }
    const dark = Boolean(payload?.dark)
    try {
      win.setTitleBarOverlay({
        color: dark ? '#0b0f14' : '#f5f7fa',
        symbolColor: dark ? '#e6edf5' : '#17202b',
        height: 38,
      })
    } catch {
      return { ok: false }
    }
    return { ok: true }
  })

  ipcMain.handle('shell:switch-environment', (_event, id) => {
    const environment = getEnvironments().find(entry => entry.id === String(id ?? ''))
    if (!environment) return { ok: false, message: 'Unknown environment.' }
    switchEnvironment(environment.id)
    return { ok: true, environment }
  })

  ipcMain.handle('appbar:context-menu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const state = getStateSnapshot()
    const t = (key, fallback) => getMessages()[key] ?? fallback
    const environments = getEnvironments()
    const activeId = getActiveEnvironmentId()
    const items = [
      { label: `${healthLabel(state, t)} · ${state.environment.name || state.environment.url || 'server'}`, enabled: false },
      { label: state.environment.url || '', enabled: false },
      { type: 'separator' },
      ...environments.map(environment => ({
        label: `${environment.name}${environment.kind === 'production' ? '  · PROD' : ''}`,
        type: 'radio',
        checked: environment.id === activeId,
        click: () => switchEnvironment(environment.id),
      })),
      { type: 'separator' },
      { label: t('appbar.testConnection', 'Test connection'), click: () => testActiveEnvironmentConnection() },
      { label: t('appbar.retry', 'Retry connection'), click: () => refreshDesktopState().catch(() => {}) },
      { label: t('appbar.serverSettings', 'Server Settings…'), click: () => createSettingsWindow() },
      {
        label: t('appbar.openLogs', 'Open logs'),
        click: () => {
          const logPath = getLogPath()
          if (logPath) shell.showItemInFolder(logPath)
        },
      },
    ]
    Menu.buildFromTemplate(items).popup({ window: win })
    return { ok: true }
  })

  ipcMain.handle('tabs:context-menu', (event, tabId) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const tabs = tabsController?.getTabs?.() ?? []
    const tab = tabs.find(entry => entry.id === String(tabId))
    if (!win || !tab) return { ok: false }
    const messages = getMessages()
    const t = (key, fallback) => messages[key] ?? fallback
    Menu.buildFromTemplate([
      { label: t('tabs.close', 'Close'), click: () => tabsController?.close(tab.id) },
      { label: t('tabs.closeOthers', 'Close other tabs'), click: () => tabsController?.closeOthers(tab.id) },
      { label: t('tabs.closeRight', 'Close tabs to the right'), click: () => tabsController?.closeToRight(tab.id) },
      { type: 'separator' },
      {
        label: t('tabs.duplicate', 'Duplicate tab'),
        enabled: Boolean(tab.runId || tab.route),
        click: () => openDashboardWindow({ route: tab.route, runId: tab.runId, dedupe: false }),
      },
      { label: t('tabs.new', 'New tab'), click: () => tabsController?.newTab({ route: 'dashboard' }) },
    ]).popup({ window: win })
    return { ok: true }
  })

  ipcMain.handle('appbar:scan-menu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const t = (key, fallback) => getMessages()[key] ?? fallback
    Menu.buildFromTemplate([
      { label: t('menu.scanClipboard', 'Scan Clipboard (IaC)'), click: () => runAction('scan-clipboard') },
      { label: t('menu.scanFolder', 'Scan Folder…'), click: () => runAction('scan-folder') },
      { label: t('menu.watchFolder', 'Watch Folder…'), click: () => runAction('watch-folder') },
      {
        label: t('menu.stopWatching', 'Stop Watching'),
        enabled: Boolean(scanController?.isWatching?.()),
        click: () => runAction('stop-watch'),
      },
    ]).popup({ window: win })
    return { ok: true }
  })

  ipcMain.handle('appbar:account-menu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const state = getStateSnapshot()
    const t = (key, fallback) => getMessages()[key] ?? fallback
    const environment = getActiveEnvironment()
    const offline = state.connection.state === 'offline'
    const signedIn = Boolean(state.auth?.signedIn)
    const deviceSession = state.auth?.method === 'device'
    const username = state.auth?.user?.displayName || state.auth?.user?.username || ''

    const items = []
    if (offline) {
      items.push({ label: t('appbar.unavailable', 'Backend unavailable'), enabled: false })
    } else {
      items.push({
        label: signedIn
          ? t('appbar.signedInAs', 'Signed in as {user}').replace('{user}', username)
          : t('appbar.notSignedIn', 'Not signed in'),
        enabled: false,
      })
    }
    if (signedIn) {
      items.push({
        label: deviceSession
          ? t('appbar.deviceSession', 'Device token')
          : t('appbar.browserSession', 'Browser session'),
        enabled: false,
      })
    }
    items.push({ type: 'separator' })
    items.push({
      label: t('appbar.signInBrowser', 'Sign in with browser…'),
      enabled: Boolean(environment) && !offline,
      click: () => signInFromAppBar(),
    })
    items.push({
      label: t('appbar.manageDevices', 'Manage devices…'),
      enabled: Boolean(environment) && !offline,
      click: () => createSettingsWindow({ tab: 'signin' }),
    })
    if (deviceSession) {
      items.push({
        label: t('appbar.signOutDevice', 'Sign out device'),
        click: () => signOutFromAppBar(),
      })
    }
    items.push({ type: 'separator' })
    items.push({ label: t('appbar.serverSettings', 'Server Settings…'), click: () => createSettingsWindow() })

    Menu.buildFromTemplate(items).popup({ window: win })
    return { ok: true }
  })
}

// ── Desktop device auth (Wave D) ────────────────────────────────────────────
// Per-request, so switching environments takes effect immediately. The token
// is stored encrypted with safeStorage; a failed decrypt simply falls back to
// cookie authentication.
function getProxyAuthHeaders() {
  try {
    const environment = getActiveEnvironment()
    if (!environment) return {}
    const token = getStoredDeviceToken(environment.id, environment.url)
    return token ? { authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

// ── IPC: server settings & preferences ──────────────────────────────────────
function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => ({
    serverUrl: getServerUrl(),
    defaultUrl: DEFAULT_SERVER_URL,
    configPath: getConfigPath(),
    logPath: getLogPath(),
    appVersion: app.getVersion(),
    preferences: getPreferences(),
    environments: getEnvironments(),
    activeEnvironmentId: getActiveEnvironmentId(),
    theme: getThemeState(),
    deviceAuth: Object.fromEntries(
      getEnvironments().map(environment => [
        environment.id,
        getDeviceStatus(environment.id, environment.url),
      ]),
    ),
    locale: getLocale(),
    i18n: getMessages(),
  }))

  ipcMain.handle('settings:set-dirty', (_event, dirty) => {
    settingsDirty = Boolean(dirty)
    return { ok: true }
  })

  ipcMain.handle('settings:test-all', async () => {
    const results = []
    for (const environment of getEnvironments()) {
      const started = performance.now()
      try {
        const response = await fetch(`${environment.url}/health`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(4_000),
        })
        results.push({
          id: environment.id,
          name: environment.name,
          url: environment.url,
          kind: environment.kind || 'local',
          ok: response.ok,
          status: response.status,
          latencyMs: Math.round(performance.now() - started),
        })
      } catch (error) {
        results.push({
          id: environment.id,
          name: environment.name,
          url: environment.url,
          kind: environment.kind || 'local',
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { ok: true, results }
  })

  ipcMain.handle('settings:relaunch', () => {
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  ipcMain.handle('settings:devices-revoke-all', async () => {
    const origin = localServer?.origin
    const environment = getActiveEnvironment()
    if (!origin || !environment) return { ok: false, message: 'The local server is not ready.' }
    try {
      const listing = await appFetch(origin, '/api/v1/auth/devices')
      if (!listing.ok) return { ok: false, message: `HTTP ${listing.status}` }
      const json = await listing.json()
      const devices = Array.isArray(json.data) ? json.data : []
      let revoked = 0
      for (const device of devices) {
        const response = await appFetch(origin, `/api/v1/auth/devices/${encodeURIComponent(device.id)}`, {
          method: 'DELETE',
        })
        if (response.ok || response.status === 404) revoked += 1
      }
      if (deviceAuthController) {
        await deviceAuthController.signOut({ environmentId: environment.id, url: environment.url })
      }
      await refreshDesktopState().catch(() => {})
      mainWindow?.webContents.reload()
      return { ok: true, revoked }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:clear-local-data', async () => {
    try {
      savePreferences({ clipboardScanConsent: false })
      writeConfig({
        deviceAuth: {},
        paletteRecents: { commands: [], searches: [] },
        windowState: undefined,
        lastExpiryNotify: null,
        lastDigestNotify: null,
        updateSnoozeUntil: null,
        crashLoopCount: null,
        crashLoopAt: null,
      })
      const ses = session.fromPartition(SESSION_PARTITION)
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb'] }).catch(() => {})
      await ses.clearCache().catch(() => {})
      deviceAuthController?.cancelAll?.()
      refreshDesktopState().catch(() => {})
      mainWindow?.webContents.reload()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:detect', async () => {
    const candidates = await detectServers()
    logger.info('server detection', { count: candidates.length })
    return { ok: true, candidates }
  })

  ipcMain.handle('settings:test', async (_event, rawUrl) => {
    const url = normalizeServerUrl(rawUrl)
    if (!url) return { ok: false, message: 'Enter a valid http(s) URL.' }
    try {
      const response = await fetch(`${url}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        return { ok: false, message: `wombat-server answered HTTP ${response.status} ${response.statusText}.` }
      }
      const body = await response.json().catch(() => ({}))
      const status = typeof body.status === 'string' ? body.status : 'ok'
      return { ok: true, message: `Connected — wombat-server is ${status} at ${url}.` }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Could not reach ${url}: ${detail}` }
    }
  })

  ipcMain.handle('settings:device-sign-in', async (_event, payload) => {
    if (!deviceAuthController) return { ok: false, message: 'Device sign-in is not ready yet.' }
    const environmentId = String(payload?.environmentId ?? '')
    const url = normalizeServerUrl(payload?.url)
    if (!environmentId || !url) return { ok: false, message: 'Save a valid server URL first.' }

    const environment = getEnvironments().find(entry => entry.id === environmentId)
    if (!environment) return { ok: false, message: 'Unknown environment.' }
    if (environment.url !== url) {
      return { ok: false, message: 'Save this environment URL before signing in.' }
    }

    const platformName = process.platform === 'darwin' ? 'macOS' : process.platform
    return deviceAuthController.signIn({
      environmentId,
      url,
      deviceName: String(payload?.deviceName || `WOMBATpass Desktop (${platformName})`),
    })
  })

  ipcMain.handle('settings:device-sign-out', async (_event, payload) => {
    if (!deviceAuthController) return { ok: false, message: 'Device sign-in is not ready yet.' }
    const environmentId = String(payload?.environmentId ?? '')
    const environment = getEnvironments().find(entry => entry.id === environmentId)
    if (!environment) return { ok: false, message: 'Unknown environment.' }
    const result = await deviceAuthController.signOut({
      environmentId,
      url: normalizeServerUrl(payload?.url) || environment.url,
    })
    await refreshDesktopState().catch(() => {})
    mainWindow?.webContents.reload()
    trayController?.pushData?.()
    return result
  })

  ipcMain.handle('settings:sessions', async () => {
    const origin = localServer?.origin
    if (!origin) return { ok: false, message: 'The local server is not ready.' }
    try {
      const response = await appFetch(origin, '/api/v1/auth/sessions')
      if (response.status === 401) return { ok: false, message: 'Sign in to view browser sessions.' }
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      const json = await response.json()
      return { ok: true, sessions: Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:session-revoke', async (_event, sessionId) => {
    const origin = localServer?.origin
    const id = String(sessionId ?? '')
    if (!origin || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: 'Unknown session.' }
    try {
      const response = await appFetch(origin, `/api/v1/auth/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}))
        return { ok: false, message: body.detail ?? `HTTP ${response.status}` }
      }
      await refreshDesktopState().catch(() => {})
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:sessions-revoke-all', async () => {
    const origin = localServer?.origin
    if (!origin) return { ok: false, message: 'The local server is not ready.' }
    try {
      const response = await appFetch(origin, '/api/v1/auth/sessions', { method: 'DELETE' })
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      const json = await response.json().catch(() => ({}))
      return { ok: true, revoked: Number(json.revoked) || 0 }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:devices', async () => {
    const origin = localServer?.origin
    if (!origin) return { ok: false, message: 'The local server is not ready.' }
    try {
      const response = await appFetch(origin, '/api/v1/auth/devices')
      if (response.status === 401) {
        return { ok: false, message: 'Sign in to the dashboard or with a device to manage devices.' }
      }
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
      const json = await response.json()
      return { ok: true, devices: Array.isArray(json.data) ? json.data : [] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:device-revoke', async (_event, payload) => {
    const origin = localServer?.origin
    const environment = getActiveEnvironment()
    const deviceId = String(payload?.deviceId ?? '')
    if (!origin || !environment || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
      return { ok: false, message: 'Unknown device.' }
    }
    try {
      const response = await appFetch(origin, `/api/v1/auth/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      })
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}))
        return { ok: false, message: body.detail ?? `HTTP ${response.status}` }
      }

      const currentDevice = getDeviceStatus(environment.id, environment.url)
      const current = currentDevice.deviceId === deviceId
      if (current && deviceAuthController) {
        await deviceAuthController.signOut({
          environmentId: environment.id,
          url: environment.url,
        })
      }
      await refreshDesktopState().catch(() => {})
      mainWindow?.webContents.reload()
      trayController?.pushData?.()
      logger.info('device revoked', { device: deviceId, current })
      return { ok: true, current }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:confirm', async (_event, options) => {
    if (process.env.WOMBAT_TEST_AUTO_CONFIRM === '1') return { ok: true }
    const environment = getActiveEnvironment()
    const production = options?.production === true || environment?.kind === 'production'
    const detail = [
      String(options?.detail ?? ''),
      production ? 'This is the PRODUCTION environment.' : '',
    ].filter(Boolean).join('\n\n')
    const { response } = await dialog.showMessageBox({
      type: production ? 'error' : 'warning',
      message: String(options?.message ?? 'Are you sure?'),
      detail,
      buttons: ['Cancel', String(options?.confirmLabel ?? 'Continue')],
      defaultId: production ? 0 : 1,
      cancelId: 0,
      noLink: true,
    })
    return { ok: response === 1 }
  })

  ipcMain.handle('settings:open-scan', () => {
    scanController?.open()
    return { ok: true }
  })

  ipcMain.handle('settings:check-updates', async () => {
    const result = await checkForUpdates()
    return result ?? { ok: true }
  })

  ipcMain.handle('settings:open-external', (_event, rawUrl) => {
    const url = normalizeServerUrl(rawUrl)
    if (!url) return { ok: false }
    shell.openExternal(url).catch((error) => {
      logger.warn('open external failed', { message: String(error) })
    })
    return { ok: true }
  })

  ipcMain.handle('settings:device-cancel', () => {
    deviceAuthController?.cancelAll()
    return { ok: true }
  })

  ipcMain.handle('settings:save', (_event, payload) => {
    const value = typeof payload === 'object' && payload !== null ? payload : { serverUrl: payload }

    let environmentsResult = null
    if (Array.isArray(value.environments)) {
      for (const environment of value.environments) {
        if (!normalizeServerUrl(environment?.url)) {
          return { ok: false, message: `Invalid URL: ${environment?.url ?? ''}` }
        }
      }
      environmentsResult = saveEnvironments(value.environments, value.activeEnvironmentId)
    } else if (value.serverUrl) {
      const url = normalizeServerUrl(value.serverUrl)
      if (!url) return { ok: false, message: 'Enter a valid http(s) URL.' }
      const activeId = getActiveEnvironmentId()
      environmentsResult = saveEnvironments(
        getEnvironments().map(environment => (
          environment.id === activeId ? { ...environment, url } : environment
        )),
        activeId,
      )
    }

    const before = getPreferences()
    let preferences = before
    if (value.preferences && typeof value.preferences === 'object') {
      const menuBarText = ['none', 'score', 'unread'].includes(value.preferences.menuBarText)
        ? value.preferences.menuBarText
        : 'none'
      preferences = savePreferences({
        launchAtLogin: Boolean(value.preferences.launchAtLogin),
        startMinimized: Boolean(value.preferences.startMinimized),
        showInDock: value.preferences.showInDock !== false,
        showToasts: value.preferences.showToasts !== false,
        notifySystem: value.preferences.notifySystem !== false,
        crashReports: value.preferences.crashReports === true,
        dndEnabled: value.preferences.dndEnabled === true,
        dndStart: String(value.preferences.dndStart ?? '22:00'),
        dndEnd: String(value.preferences.dndEnd ?? '07:00'),
        updateFeedUrlBeta: String(value.preferences.updateFeedUrlBeta ?? '').trim(),
        updateChannel: value.preferences.updateChannel === 'beta' ? 'beta' : 'stable',
        updateCheckInterval: ['off', 'daily', 'weekly'].includes(value.preferences.updateCheckInterval) ? value.preferences.updateCheckInterval : 'off',
        zoomFactor: Math.max(0.8, Math.min(1.5, Number(value.preferences.zoomFactor) || 1)),
        theme: ['system', 'light', 'dark'].includes(value.preferences.theme) ? value.preferences.theme : before.theme,
        locale: ['system', 'en', 'de'].includes(value.preferences.locale) ? value.preferences.locale : before.locale,
        nativeChrome: value.preferences.nativeChrome !== false,
        restoreTabs: value.preferences.restoreTabs === true,
        menuBarText,
        notifyFindings: Boolean(value.preferences.notifyFindings),
        notifyGovernance: Boolean(value.preferences.notifyGovernance),
        updateFeedUrl: String(value.preferences.updateFeedUrl ?? '').trim(),
        dockerComposePath: String(value.preferences.dockerComposePath ?? '').trim(),
      })

      // Only touch the OS items when they actually changed (or are enabled).
      if (preferences.launchAtLogin || before.launchAtLogin !== preferences.launchAtLogin) {
        applyLoginItem(preferences)
      }
      if (before.showInDock !== preferences.showInDock) {
        applyDockVisibility(preferences)
      }
    }

    const restartRequired = before.nativeChrome !== preferences.nativeChrome
    setThemeMode(preferences.theme, { persist: true })
    setLocalePreference(preferences.locale, { persist: true })
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.getURL().startsWith(localServer?.origin ?? '')) {
        applyDashboardZoom(win)
      }
    }

    const activeEnvironment = getActiveEnvironmentId()
    logger.info('settings saved', {
      environment: activeEnvironment,
      environments: environmentsResult?.environments.length ?? getEnvironments().length,
    })
    refreshDesktopState().catch(() => {})

    // The proxy resolves the target per request; a reload is enough for the
    // dashboard's connection checks to pick up the new backend.
    mainWindow?.webContents.reload()
    return {
      ok: true,
      serverUrl: getServerUrl(),
      environments: environmentsResult?.environments ?? getEnvironments(),
      activeEnvironmentId: environmentsResult?.activeEnvironmentId ?? activeEnvironment,
      preferences,
      restartRequired,
    }
  })

  ipcMain.handle('settings:show-logs', () => {
    const logPath = getLogPath()
    if (logPath) shell.showItemInFolder(logPath)
    return { ok: Boolean(logPath), logPath }
  })

  ipcMain.handle('settings:close', () => {
    settingsWindow?.close()
    return { ok: true }
  })
}

// ── Startup connection check ────────────────────────────────────────────────
async function promptOffline() {
  const locale = getLocale()
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: locale === 'de' ? 'wombat-server ist nicht erreichbar' : 'wombat-server is not reachable',
      detail: locale === 'de'
        ? `${getServerUrl()} antwortet nicht auf /health.\n\nStarte den Docker-Stack oder prüfe die Server-URL.`
        : `${getServerUrl()} did not answer /health.\n\nStart the Docker stack or check the server URL.`,
      buttons: locale === 'de'
        ? ['Erneut versuchen', 'Server-Einstellungen…', 'Trotzdem öffnen', 'Beenden']
        : ['Retry', 'Server Settings…', 'Open Anyway', 'Quit'],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    })

    if (response === 0) {
      if (await probeHealth(getServerUrl())) return 'open'
      continue
    }
    if (response === 1) return 'settings'
    if (response === 2) return 'open'
    return 'quit'
  }
}

function applyOsIntegration() {
  const messages = getMessages()
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setMenu(Menu.buildFromTemplate([
        { label: messages['menu.openDashboard'] ?? 'Open Dashboard', click: () => runAction('open-dashboard') },
        { label: messages['menu.commandPalette'] ?? 'Command Palette', click: () => runAction('palette') },
        { type: 'separator' },
        { label: messages['menu.scanClipboard'] ?? 'Scan Clipboard (IaC)', click: () => runAction('scan-clipboard') },
        { label: messages['menu.scanFolder'] ?? 'Scan Folder…', click: () => runAction('scan-folder') },
        { label: messages['menu.stackConsole'] ?? 'Stack Console', click: () => runAction('stack') },
        { type: 'separator' },
        { label: messages['menu.settings'] ?? 'Server Settings…', click: () => createSettingsWindow() },
      ]))
    } catch (error) {
      logger.warn('dock menu', { message: String(error) })
    }
  }
  if (process.platform === 'win32') {
    try {
      app.setJumpList([
        {
          type: 'tasks',
          items: [
            { type: 'task', title: messages['menu.openDashboard'] ?? 'Open Dashboard', program: process.execPath, args: ['--open-route', 'dashboard'] },
            { type: 'task', title: messages['menu.scanFolder'] ?? 'Scan Folder…', program: process.execPath, args: ['--open-route', 'runscan'] },
            { type: 'task', title: messages['menu.settings'] ?? 'Server Settings…', program: process.execPath, args: ['--open-route', 'settings'] },
          ],
        },
      ])
    } catch (error) {
      logger.warn('jump list', { message: String(error) })
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
async function bootstrap() {
  markPerf('app-ready')
  initTheme()
  initI18n()

  // Evaluate first-run before any getServerUrl() call migrates the config.
  const initialConfig = readConfig()
  const firstRun = !initialConfig.serverUrl && !Array.isArray(initialConfig.environments)
  if (!firstRun && getPreferences().restoreTabs && Array.isArray(initialConfig.openTabs)) {
    startupSavedTabs = initialConfig.openTabs
    startupSavedActiveIndex = Number(initialConfig.activeTabIndex) || 0
  }

  const dashboardDir = getDashboardDir()

  try {
    localServer = await startServer({
      dashboardDir,
      port: Number(process.env.WOMBAT_PORT ?? DEFAULT_PORT),
      getTargetUrl: getServerUrl,
      getAuthHeaders: getProxyAuthHeaders,
      onProxyResponse: handleProxyResponse,
    })
  } catch (error) {
    handleFatal(error)
    return
  }

  initDesktopState({ getOrigin: () => localServer?.origin ?? '' })

  tabsController = createTabs({
    openWindow: meta => openDashboardWindow({
      runId: meta?.runId ?? null,
      route: meta?.route ?? null,
    }),
    onActivate: (win) => { mainWindow = win },
    onClosed: (tab) => publishToast({
      level: 'info',
      title: tt('toast.tabClosedTitle', 'Tab closed'),
      body: tab.title || tab.route || '',
      action: { kind: 'reopen-tab', route: tab.route, runId: tab.runId },
      actionLabel: tt('toast.undo', 'Undo'),
      key: `tab-closed:${Date.now()}`,
    }),
    onError: (message) => publishToast({ level: 'warning', title: tt('toast.tabsWarningTitle', 'Tabs'), body: message, key: 'tabs-limit' }),
    onNotice: (count) => publishToast({
      level: 'warning',
      title: tt('toast.tabsWarningTitle', 'Tabs'),
      body: tt('toast.tabsWarningBody', '{count} tabs are open. Close inactive tabs to reduce memory use.', { count }),
      key: 'tabs-memory',
      ttl: 10_000,
    }),
  })

  markPerf('local-server-ready')

  logger.info('local server started', {
    dashboard: dashboardDir,
    origin: localServer.origin,
    backend: getServerUrl(),
  })

  const preferences = getPreferences()
  // Only touch the login item when it is enabled; calling it with false on
  // every launch fails noisily for unbundled dev builds.
  if (preferences.launchAtLogin) applyLoginItem(preferences)
  applyDockVisibility(preferences)

  deviceAuthController = createDeviceAuth({
    onStatus: (payload) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('settings:device-status', payload)
      }
    },
    onSignedIn: (result) => {
      publishToast({
        level: 'success',
        title: tt('toast.deviceSignedInTitle', 'Device signed in'),
        body: result?.username ? tt('toast.deviceSignedInBody', 'Signed in as {user}.', { user: result.username }) : 'The device token is ready.',
        key: `device-signin:${result?.environmentId || ''}`,
      })
      refreshDesktopState().catch(() => {})
      mainWindow?.webContents.reload()
      trayController?.pushData?.()
    },
  })

  registerDiagnosticsIpc()
  registerCrashIpc()
  registerUpdateIpc()
  registerOnboardingIpc({ getTargetWindow: () => mainWindow })
  registerSettingsIpc()
  registerAppActionIpc()
  registerAppBarMenus()

  stackController = createStack({ navigate: navigateTo })
  quickScanController = createQuickScan({ origin: localServer.origin, navigate: navigateTo })
  scanController = createScanFolder({ origin: localServer.origin, navigate: navigateTo })
  subscribeScanJobs(() => broadcastScanJobs())
  refreshScanJobs(localServer.origin).then(() => broadcastScanJobs()).catch(() => {})
  paletteController = createPalette({
    origin: localServer.origin,
    getContext: getDashboardContext,
    getActions: () => paletteActions(),
    onCommand: handlePaletteCommand,
  })
  helpController = createHelp({ navigate: navigateTo })

  Menu.setApplicationMenu(buildMenu({
    getWindow: () => mainWindow,
    onOpenSettings: () => createSettingsWindow(),
    onShowLogs: () => {
      const logPath = getLogPath()
      if (logPath) shell.showItemInFolder(logPath)
    },
    onCheckUpdates: () => { checkForUpdates() },
    onNewWindow: () => openDashboardWindow({}),
    onPrint: () => printPage(),
    onSavePdf: () => savePageAsPdf(),
    onOpenHelp: () => helpController?.open(),
  }))

  trayController = createTray({
    origin: localServer.origin,
    getContext: getDashboardContext,
    switchEnvironment,
    onCheckUpdates: () => { checkForUpdates() },
    isWatching: () => Boolean(scanController?.isWatching?.()),
    actions: {
      palette: () => paletteController?.open(),
      scanClipboard: () => quickScanController?.scanClipboard(),
      scanFolder: () => scanController?.open(),
      watchFolder: () => scanController?.chooseWatch(),
      stopWatch: () => scanController?.stopWatching(),
      stack: () => stackController?.open(),
      openTab: (runId) => openDashboardWindow({ runId }),
      help: () => helpController?.open(),
      manageDevices: () => createSettingsWindow({ tab: 'signin' }),
      signInDevice: () => signInFromAppBar(),
      signOutDevice: () => signOutFromAppBar(),
    },
    showDashboard: ({ runId = null, route = null } = {}) => {
      if (!mainWindow) createMainWindow(localServer.origin)
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()

      if (route) {
        const safe = String(route).replace(/[^a-z0-9/_-]/gi, '')
        if (safe) {
          const query = runId ? `?run=${encodeURIComponent(runId)}` : ''
          mainWindow.loadURL(`${localServer.origin}/#/${safe}${query}`)
        }
      } else if (runId) {
        mainWindow.loadURL(`${localServer.origin}/#/dashboard?run=${encodeURIComponent(runId)}`)
      }
    },
    openSettings: () => createSettingsWindow(),
  })

  registerShortcuts({
    togglePopover: () => trayController?.togglePopover(),
    openDashboard: () => navigateTo({ route: 'dashboard' }),
    scanClipboard: () => quickScanController?.scanClipboard(),
    openPalette: () => paletteController?.open(),
    openDropZone: () => scanController?.open(),
    newWindow: () => openDashboardWindow({}),
  })

  if (process.env.WOMBAT_POPOVER_DEMO === '1') {
    setTimeout(() => trayController?.showPopover(), 800)
  }

  // Development/QA aid: open a specific window on launch.
  if (process.env.WOMBAT_OPEN) {
    setTimeout(() => {
      switch (process.env.WOMBAT_OPEN) {
        case 'palette': paletteController?.open(); break
        case 'stack': stackController?.open(); break
        case 'dropzone': scanController?.open(); break
        case 'quickscan': quickScanController?.scanClipboard(); break
        case 'tab': openDashboardWindow({}); break
        default: break
      }
    }, 1_500)
  }

  if (firstRun) {
    createSettingsWindow({ firstRun: true })
    return
  }

  let action = 'auto'
  if (!(await probeHealth(getServerUrl()))) {
    logger.warn('backend unreachable at startup', { url: getServerUrl() })
    action = await promptOffline()
  }

  if (action === 'settings') {
    createSettingsWindow({ firstRun: true })
  } else if (action === 'quit') {
    logger.info('quit from offline dialog')
    app.quit()
    return
  } else if (action === 'open' || !preferences.startMinimized) {
    createMainWindow(localServer.origin)
  }

  flushPendingLinks()
  if (pendingLinks.length === 0) restoreSavedTabs()
  applyOsIntegration()
  startUpdateScheduler()

  app.on('activate', () => {
    if (!mainWindow && localServer && !isQuitting) {
      createMainWindow(localServer.origin)
    }
  })
}

// One instance only: a second launch focuses the existing window instead of
// fighting over the fixed loopback port.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    logger.info('second instance', { argv, workingDirectory })
    for (const link of parseArgv(argv)) {
      if (link.action === 'scan') scanController?.scanFolder(link.path)
      else navigateTo(link)
    }

    if (settingsWindow) {
      settingsWindow.focus()
      return
    }
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch(handleFatal)
}

// macOS convention: the app stays in the dock after the last window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Flush the cookie store on quit. Chromium batches cookie writes, and a
// desktop app that is quit right after login would otherwise lose its
// session (hard kills such as SIGKILL cannot be helped).
let flushStarted = false
app.on('will-quit', (event) => {
  if (flushStarted) return
  flushStarted = true
  event.preventDefault()

  const ses = session.fromPartition(SESSION_PARTITION)
  const flush = ses?.cookies?.flushStore?.() ?? Promise.resolve()
  const timeout = new Promise(resolve => setTimeout(resolve, 2_000))

  Promise.race([flush, timeout])
    .finally(() => {
      // Fire and forget: the server closes its sockets itself, and waiting on
      // it here could block quitting on a keep-alive connection.
      unregisterShortcuts()
      stackController?.destroy?.()
      quickScanController?.destroy?.()
      paletteController?.destroy?.()
      scanController?.destroy?.()
      helpController?.destroy?.()
      trayController?.destroy?.()
      if (updateTimer) clearInterval(updateTimer)
      updateTimer = null
      stopDesktopState()
      stopTheme()
      localServer?.close?.()
      logger.info('quitting')
      app.quit()
    })
})
