/**
 * Desktop shell state hub (UI Wave U0).
 *
 * Main process is the source of truth for everything the shell chrome shows:
 * environment/health, authentication, connection, unread count, scan jobs and
 * updates. Renderers receive display-only snapshots over `shell:state`; they
 * never receive tokens, CSRF values or raw config.
 *
 * Sources may patch their slice directly (`patchState`) — the tray, scan
 * controller, device auth and update checker do. Health and auth are refreshed
 * here with lightweight polling so the hub has a baseline even when the tray
 * is closed. Later UI waves add more slices without changing the transport.
 */
import { BrowserWindow, app, ipcMain, session } from 'electron'

import { getActiveEnvironment, getServerUrl } from './config.js'
import { getDeviceStatus } from './device-auth.js'
import { logger } from './logger.js'
import { SESSION_PARTITION } from './security.js'
import { publishToast } from './toasts.js'
import { tt } from './i18n.js'

const HEALTH_INTERVAL_MS = 20_000
const AUTH_INTERVAL_MS = 60_000
const BROADCAST_DEBOUNCE_MS = 120

const state = {
  environment: {
    id: '',
    name: '',
    url: '',
    kind: 'local',
    health: 'unknown', // unknown | connected | degraded | offline
    latencyMs: null,
    serverVersion: '',
    lastSyncAt: null,
  },
  auth: {
    signedIn: false,
    expired: false,
    method: 'none', // none | cookie | device
    user: null,
    device: null,
  },
  connection: { state: 'unknown', since: null, error: '' },
  notifications: { unread: 0 },
  scan: {
    watching: { active: false, path: '' },
    running: 0,
    jobs: [],
  },
  update: { state: 'idle', current: '', latest: '', notes: '', progress: 0 },
  ui: {
    theme: 'system',
    effectiveTheme: 'dark',
    highContrast: false,
    reducedMotion: false,
    locale: 'en',
  },
}

let getOrigin = () => ''
let broadcastTimer = null
let healthTimer = null
let healthFailures = 0
let healthStopped = false
let authTimer = null
let registered = false
let lastAuthRefresh = 0

function clone(value) {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

export function getStateSnapshot() {
  return clone(state)
}

/** Merge one level into each top-level section and schedule a broadcast. */
export function patchState(patch) {
  if (!patch || typeof patch !== 'object') return getStateSnapshot()
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      state[key] &&
      typeof state[key] === 'object' &&
      !Array.isArray(state[key])
    ) {
      state[key] = { ...state[key], ...value }
    } else {
      state[key] = value
    }
  }
  scheduleBroadcast()
  return getStateSnapshot()
}

function scheduleBroadcast() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    const snapshot = getStateSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('shell:state', snapshot)
      } catch {
        /* window is going away */
      }
    }
  }, BROADCAST_DEBOUNCE_MS)
  broadcastTimer.unref?.()
}

function setConnection(nextState, error = '') {
  const previous = state.connection.state
  const changed = previous !== nextState
  const connection = {
    state: nextState,
    error,
    since: changed ? new Date().toISOString() : state.connection.since,
  }
  patchState({
    connection,
    environment: {
      health: nextState === 'connected' ? 'connected' : nextState === 'degraded' ? 'degraded' : 'offline',
    },
  })
  if (changed) {
    logger.info('shell connection state', { state: nextState, error })
    if (previous !== 'unknown') {
      if (nextState === 'offline') {
        publishToast({
          level: 'error',
          title: tt('toast.connectionLostTitle', 'Connection lost'),
          body: tt('toast.connectionLostBody', '{name} is unreachable.', { name: state.environment.name || 'wombat-server' }),
          action: { kind: 'settings', tab: 'connection' },
          key: `connection-offline:${state.environment.id || ''}`,
        })
      } else if (nextState === 'connected') {
        publishToast({
          level: 'success',
          title: tt('toast.connectionRestoredTitle', 'Connection restored'),
          body: tt('toast.connectionRestoredBody', '{name} is reachable again.', { name: state.environment.name || 'wombat-server' }),
          key: `connection-restored:${state.environment.id || ''}`,
        })
      }
    }
  }
}

export function refreshEnvironment() {
  let environment
  try {
    environment = getActiveEnvironment()
  } catch {
    environment = null
  }
  if (!environment) return

  const previousId = state.environment.id
  const changed = previousId && previousId !== environment.id
  const device = getDeviceStatus(environment.id, environment.url)

  patchState({
    environment: {
      id: environment.id,
      name: environment.name || environment.url,
      url: environment.url,
      kind: environment.kind || 'local',
    },
    auth: changed
      ? {
          signedIn: false,
          expired: false,
          method: 'none',
          user: null,
          device: null,
        }
      : {
          device: device.signedIn
            ? {
                id: device.deviceId || '',
                name: device.deviceName || '',
                lastUsedAt: device.savedAt || null,
              }
            : null,
        },
  })
}

export async function refreshHealth() {
  const url = getServerUrl()
  const started = performance.now()
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    })
    const latencyMs = Math.round(performance.now() - started)
    const body = await response.json().catch(() => ({}))
    patchState({
      environment: {
        latencyMs,
        serverVersion: typeof body.version === 'string' ? body.version : state.environment.serverVersion,
        lastSyncAt: new Date().toISOString(),
      },
    })
    setConnection(response.ok ? 'connected' : 'degraded', response.ok ? '' : `HTTP ${response.status}`)
    if (response.ok) healthFailures = 0
    return response.ok
  } catch (error) {
    setConnection('offline', error instanceof Error ? error.message : String(error))
    healthFailures += 1
    return false
  }
}

export async function refreshAuth() {
  lastAuthRefresh = Date.now()
  const origin = getOrigin()
  if (!origin) return

  try {
    const ses = session.fromPartition(SESSION_PARTITION)
    const response = await ses.fetch(`${origin}/api/v1/auth/me`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status === 401) {
      patchState({
        auth: {
          signedIn: false,
          expired: state.auth.signedIn ? true : state.auth.expired,
          method: 'none',
          user: null,
        },
      })
      return
    }
    if (!response.ok) return

    const user = await response.json()
    const device = getDeviceStatus(state.environment.id, state.environment.url)
    patchState({
      auth: {
        signedIn: true,
        expired: false,
        method: device.signedIn ? 'device' : 'cookie',
        user: {
          username: user.username || '',
          displayName: user.display_name || '',
          role: user.role || '',
        },
      },
    })
  } catch {
    /* backend/offline: keep the last known auth state */
  }
}

export async function refreshDesktopState() {
  refreshEnvironment()
  await Promise.allSettled([refreshHealth(), refreshAuth()])
}

function registerIpc() {
  if (registered) return
  registered = true

  ipcMain.handle('shell:get-state', () => getStateSnapshot())

  ipcMain.handle('shell:action', async (_event, action) => {
    const name = String(action ?? '')
    if (name === 'refresh') {
      await refreshDesktopState()
      return { ok: true, state: getStateSnapshot() }
    }
    return { ok: false, message: `Unknown shell action: ${name}` }
  })
}

export function initDesktopState({ getOrigin: originResolver } = {}) {
  getOrigin = typeof originResolver === 'function' ? originResolver : () => ''
  registerIpc()
  refreshEnvironment()

  refreshDesktopState().catch((error) => {
    logger.warn('desktop state initial refresh', {
      message: error instanceof Error ? error.message : String(error),
    })
  })

  healthStopped = false
  const scheduleHealth = () => {
    if (healthStopped) return
    const base = Math.min(300_000, HEALTH_INTERVAL_MS * Math.pow(1.6, Math.max(0, healthFailures)))
    const delay = Math.round(base + Math.random() * Math.min(15_000, base * 0.2))
    healthTimer = setTimeout(async () => {
      await refreshHealth().catch(() => {})
      scheduleHealth()
    }, delay)
    healthTimer.unref?.()
  }
  scheduleHealth()
  authTimer = setInterval(() => {
    refreshAuth().catch(() => {})
  }, AUTH_INTERVAL_MS)
  healthTimer.unref?.()
  authTimer.unref?.()

  // After an in-app dashboard login, refresh on the next focus instead of
  // waiting up to a minute for the account chip to catch up.
  app.on('browser-window-focus', () => {
    if (Date.now() - lastAuthRefresh < 5_000) return
    refreshAuth().catch(() => {})
  })
}

export function stopDesktopState() {
  healthStopped = true
  if (healthTimer) clearTimeout(healthTimer)
  if (authTimer) clearInterval(authTimer)
  if (broadcastTimer) clearTimeout(broadcastTimer)
  healthTimer = null
  authTimer = null
  broadcastTimer = null
}
