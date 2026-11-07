/**
 * Redacted diagnostics bundle (UI Wave U4).
 *
 * Shared by Help → Diagnostics and the crash page. Never includes device
 * tokens, session cookies, CSRF values, password hashes or raw config.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BrowserWindow, app, clipboard, dialog, ipcMain } from 'electron'

import {
  getActiveEnvironment,
  getConfigPath,
  getEnvironments,
  getPreferences,
  readConfig,
  getServerUrl,
} from './config.js'
import { getStateSnapshot } from './desktop-state.js'
import { logger } from './logger.js'

const MAX_LOG_LINES = 200

export function redactText(value) {
  return String(value ?? '')
    .replace(/wombat_dev_[A-Za-z0-9_-]+/g, 'wombat_dev_[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(wombat_(?:access|refresh|csrf))=([^;\s]+)/gi, '$1=[redacted]')
    .replace(/("?(?:password|passwd|token|secret|authorization|cookie|api[_-]?key)"?\s*[:=]\s*)"?[^"\s,}]+/gi, '$1[redacted]')
}

function safeUrl(raw) {
  try {
    const url = new URL(String(raw))
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return ''
  }
}

function readLogTail() {
  const file = (() => {
    try {
      return path.join(app.getPath('logs'), 'main.log')
    } catch {
      return ''
    }
  })()
  if (!file) return { path: '', lines: [] }
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(Boolean).slice(-MAX_LOG_LINES)
    return { path: file, lines: lines.map(redactText) }
  } catch {
    return { path: file, lines: [] }
  }
}

function safePreferences() {
  const prefs = getPreferences()
  return {
    theme: prefs.theme,
    locale: prefs.locale,
    launchAtLogin: Boolean(prefs.launchAtLogin),
    startMinimized: Boolean(prefs.startMinimized),
    showInDock: prefs.showInDock !== false,
    menuBarText: prefs.menuBarText,
    notifyFindings: Boolean(prefs.notifyFindings),
    notifyGovernance: Boolean(prefs.notifyGovernance),
    showToasts: prefs.showToasts !== false,
    widgetProject: prefs.widgetProject || '',
    updateFeedUrl: (() => { try { return new URL(prefs.updateFeedUrl || '').origin } catch { return '' } })(),
    updateFeedBetaUrl: (() => { try { return new URL(prefs.updateFeedUrlBeta || '').origin } catch { return '' } })(),
    dockerComposePath: prefs.dockerComposePath || '',
  }
}

export function collectDiagnostics({ crash = null } = {}) {
  const state = getStateSnapshot()
  const environment = getActiveEnvironment()
  const log = readLogTail()
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    environment: environment
      ? {
          id: environment.id,
          name: environment.name,
          url: safeUrl(environment.url),
          kind: environment.kind || 'local',
        }
      : null,
    serverUrl: safeUrl(getServerUrl()),
    connection: state.connection,
    health: {
      state: state.environment.health,
      latencyMs: state.environment.latencyMs,
      serverVersion: state.environment.serverVersion,
      lastSyncAt: state.environment.lastSyncAt,
    },
    auth: {
      signedIn: Boolean(state.auth.signedIn),
      method: state.auth.method,
      user: state.auth.user
        ? { username: state.auth.user.username, role: state.auth.user.role }
        : null,
    },
    notifications: { unread: state.notifications.unread },
    scan: {
      running: state.scan.running,
      watching: state.scan.watching,
      recentJobs: Array.isArray(state.scan.jobs) ? state.scan.jobs.length : 0,
    },
    update: {
      state: state.update.state,
      current: state.update.current,
      latest: state.update.latest,
    },
    paths: {
      config: getConfigPath(),
      log: log.path,
    },
    preferences: safePreferences(),
    environments: getEnvironments().map(entry => ({
      id: entry.id,
      name: entry.name,
      url: safeUrl(entry.url),
      kind: entry.kind || 'local',
    })),
    crash: crash ? {
      reason: String(crash.reason ?? ''),
      exitCode: crash.exitCode ?? null,
    } : {
      loopCount: Number(readConfig().crashLoopCount) || 0,
      lastAt: readConfig().crashLoopAt || null,
    },
    metrics: app.getAppMetrics().map(metric => ({
      type: metric.type,
      pid: metric.pid,
      workingSetKb: metric.memory?.workingSetSize ?? null,
      cpuPercent: metric.cpu?.percentCPUUsage ?? null,
    })),
    logTail: log.lines,
  }
}

export function formatDiagnostics(options = {}) {
  return `${JSON.stringify(collectDiagnostics(options), null, 2)}\n`
}

async function copyDiagnostics(options = {}) {
  await clipboard.writeText(formatDiagnostics(options))
  return { ok: true }
}

export async function saveDiagnostics(owner, options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dialogOptions = {
    title: 'Save diagnostics',
    defaultPath: path.join(app.getPath('documents'), `wombatpass-diagnostics-${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt'] }],
  }
  const { canceled, filePath } = owner
    ? await dialog.showSaveDialog(owner, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    fs.writeFileSync(filePath, formatDiagnostics(options), 'utf8')
    return { ok: true, filePath }
  } catch (error) {
    logger.warn('diagnostics save failed', { message: String(error) })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let registered = false

export function registerDiagnosticsIpc() {
  if (registered) return
  registered = true
  ipcMain.handle('diagnostics:get', (_event, options) => {
    const crash = options && typeof options === 'object' ? options.crash ?? null : null
    return { ok: true, diagnostics: collectDiagnostics({ crash }) }
  })
  ipcMain.handle('diagnostics:copy', (_event, options) => {
    const crash = options && typeof options === 'object' ? options.crash ?? null : null
    return copyDiagnostics({ crash })
  })
  ipcMain.handle('diagnostics:save', (event, options) => {
    const crash = options && typeof options === 'object' ? options.crash ?? null : null
    const owner = event.sender ? BrowserWindow.fromWebContents(event.sender) : null
    return saveDiagnostics(owner, { crash })
  })
}
