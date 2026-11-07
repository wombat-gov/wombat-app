/**
 * Electron-only configuration: window defaults, dashboard location,
 * environments, preferences and window state.
 *
 * Kept out of server.js so the static server can run standalone under plain
 * Node (`npm run serve`).
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export const APP_TITLE = 'WOMBATpass Dashboard'
export const DEFAULT_PORT = 47823
// docker-compose publishes wombat-server on 8000.
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000'
export const DEFAULT_ENVIRONMENT = {
  id: 'local',
  name: 'Local Docker',
  url: DEFAULT_SERVER_URL,
  kind: 'local', // local | staging | production
}

export const WINDOW_DEFAULTS = {
  width: 1440,
  height: 900,
  minWidth: 1024,
  minHeight: 680,
  backgroundColor: '#0b0f14',
}

/** Directory that contains the built dashboard (index.html + assets). */
export function getDashboardDir() {
  const override = process.env.WOMBAT_DASHBOARD_DIR
  if (override) return path.resolve(override)

  if (app.isPackaged) return path.join(process.resourcesPath, 'dashboard')

  // Prefer the bundle produced by `npm run dashboard:build` (empty API base,
  // so the app talks to the local proxy). Fall back to the dashboard's own
  // dist while it has not been built yet.
  const localBuild = path.resolve(app.getAppPath(), 'build', 'dashboard')
  if (fs.existsSync(path.join(localBuild, 'index.html'))) return localBuild

  return path.resolve(app.getAppPath(), '..', 'wafpass-dashboard', 'dist')
}

export function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

/** Persisted user settings. */
export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true })
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

// ── Environments ────────────────────────────────────────────────────────────
let migrated = false

function migrateLegacyConfig() {
  if (migrated) return
  migrated = true
  try {
    const cfg = readConfig()
    if (!Array.isArray(cfg.environments) || cfg.environments.length === 0) {
      const url = typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()
        ? cfg.serverUrl.trim().replace(/\/+$/, '')
        : DEFAULT_ENVIRONMENT.url
      writeConfig({
        environments: [{ ...DEFAULT_ENVIRONMENT, url }],
        activeEnvironmentId: DEFAULT_ENVIRONMENT.id,
      })
    }
  } catch {
    /* config is best effort */
  }
}

function cleanEnvironments(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .filter(entry => entry && typeof entry.url === 'string' && entry.url.trim())
    .map(entry => {
      const url = String(entry.url).trim().replace(/\/+$/, '')
      const kind = ['local', 'staging', 'production'].includes(entry.kind) ? entry.kind : 'local'
      return {
        id: String(entry.id || entry.name || url),
        name: String(entry.name || url),
        url,
        kind,
      }
    })

  if (!cleaned.some(entry => entry.id === DEFAULT_ENVIRONMENT.id)) {
    cleaned.unshift({ ...DEFAULT_ENVIRONMENT })
  }
  return cleaned
}

export function getEnvironments() {
  migrateLegacyConfig()
  return cleanEnvironments(readConfig().environments)
}

export function getActiveEnvironmentId() {
  const stored = readConfig().activeEnvironmentId
  const environments = getEnvironments()
  return environments.some(entry => entry.id === stored) ? stored : environments[0].id
}

export function getActiveEnvironment() {
  const environments = getEnvironments()
  const id = getActiveEnvironmentId()
  return environments.find(entry => entry.id === id) ?? environments[0]
}

export function saveEnvironments(environments, activeId) {
  const cleaned = cleanEnvironments(environments)
  const active = cleaned.some(entry => entry.id === activeId) ? activeId : cleaned[0].id

  // Drop device tokens for environments that were deleted or renamed away.
  const cfg = readConfig()
  const deviceAuth = cfg.deviceAuth && typeof cfg.deviceAuth === 'object' ? { ...cfg.deviceAuth } : {}
  for (const id of Object.keys(deviceAuth)) {
    if (!cleaned.some(entry => entry.id === id)) delete deviceAuth[id]
  }

  writeConfig({ environments: cleaned, activeEnvironmentId: active, deviceAuth })
  return { environments: cleaned, activeEnvironmentId: active }
}

// ── Desktop device tokens (Wave D) ──────────────────────────────────────────
// Records are keyed by environment id and hold a safeStorage-encrypted token
// plus display metadata. They are never sent to a renderer.
export function getDeviceAuthRecord(environmentId) {
  const map = readConfig().deviceAuth
  if (!map || typeof map !== 'object') return null
  const record = map[environmentId]
  return record && typeof record === 'object' ? record : null
}

export function setDeviceAuthRecord(environmentId, record) {
  const map = readConfig().deviceAuth
  const next = { ...(map && typeof map === 'object' ? map : {}), [environmentId]: record }
  writeConfig({ deviceAuth: next })
  return record
}

export function deleteDeviceAuthRecord(environmentId) {
  const map = readConfig().deviceAuth
  if (!map || typeof map !== 'object' || !(environmentId in map)) return false
  const next = { ...map }
  delete next[environmentId]
  writeConfig({ deviceAuth: next })
  return true
}

export function getDeviceAuthRecords() {
  const map = readConfig().deviceAuth
  return map && typeof map === 'object' ? map : {}
}

export function setActiveEnvironment(id) {
  const environments = getEnvironments()
  const environment = environments.find(entry => entry.id === id)
  if (!environment) return null
  writeConfig({ activeEnvironmentId: id })
  return environment
}

/**
 * Backend used for /health and the /api proxy.
 * Precedence: active environment → WOMBAT_SERVER_URL → default.
 */
export function getServerUrl() {
  try {
    const active = getActiveEnvironment()
    if (active?.url) return active.url
  } catch {
    /* fall through */
  }
  const fromEnv = process.env.WOMBAT_SERVER_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  return DEFAULT_SERVER_URL
}

/**
 * Extra hosts the app window may navigate to (e.g. a remote Keycloak, Entra
 * or Okta host used for SSO). Loopback hosts and the backend host are always
 * allowed; this is only for everything else.
 */
export function getAllowedNavigationHosts() {
  const fromEnv = (process.env.WOMBAT_ALLOWED_NAV_HOSTS ?? '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const stored = readConfig().allowedNavigationHosts
  const fromConfig = Array.isArray(stored)
    ? stored.map(value => String(value).trim().toLowerCase()).filter(Boolean)
    : []
  return [...fromEnv, ...fromConfig]
}

// ── Preferences ─────────────────────────────────────────────────────────────
const DEFAULT_PREFERENCES = {
  zoomFactor: 1,
  theme: 'system', // system | light | dark
  locale: 'system', // system | en | de
  nativeChrome: true,
  restoreTabs: false,
  onboardingVersion: '',
  whatsNewSeen: '',
  launchAtLogin: false,
  startMinimized: false,
  showInDock: true,
  showToasts: true,
  menuBarText: 'none', // none | score | unread
  notifyFindings: true,
  notifyGovernance: true,
  notifySystem: true,
  crashReports: false,
  clipboardScanConsent: false,
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '07:00',
  updateFeedUrl: '',
  updateFeedUrlBeta: '',
  updateChannel: 'stable', // stable | beta
  updateCheckInterval: 'off', // off | daily | weekly
  updateSnoozeUntil: null,
  updateLastChecked: null,
  dockerComposePath: '',
  widgetProject: '', // '' = all projects
}

export function getPreferences() {
  const stored = readConfig().preferences
  return {
    ...DEFAULT_PREFERENCES,
    ...(stored && typeof stored === 'object' ? stored : {}),
  }
}

export function savePreferences(patch) {
  const preferences = { ...getPreferences(), ...patch }
  writeConfig({ preferences })
  return preferences
}

export function applyLoginItem(preferences = getPreferences()) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(preferences.launchAtLogin) })
  } catch (error) {
    // Do not couple config to the logger; main logs this if needed.
    console.error(`[wombat-app] login item: ${error instanceof Error ? error.message : error}`)
  }
}

export function applyDockVisibility(preferences = getPreferences()) {
  try {
    if (preferences.showInDock === false) app.dock?.hide()
    else app.dock?.show()
  } catch (error) {
    console.error(`[wombat-app] dock visibility: ${error instanceof Error ? error.message : error}`)
  }
}

// ── Window state ────────────────────────────────────────────────────────────
export function getWindowState() {
  const state = readConfig().windowState
  return state && typeof state === 'object' ? state : null
}

export function saveWindowState(state) {
  writeConfig({ windowState: state })
}
