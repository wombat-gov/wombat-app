/**
 * Renderer hardening: navigation guard, permission policy, download handling.
 *
 * The dashboard only needs same-origin navigation plus the SSO round trip
 * (backend → IdP → back). Everything else is sent to the user's default
 * browser instead of being loaded inside the app window.
 */
import path from 'node:path'
import { app, dialog, shell } from 'electron'

import { getAllowedNavigationHosts, getServerUrl } from './config.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Fullscreen is used by the map controls. Clipboard access is granted only to
// the app's own origin (see configureSession).
const ALLOWED_PERMISSIONS = new Set(['fullscreen'])
const CLIPBOARD_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])

const configuredSessions = new WeakSet()

export const SESSION_PARTITION = 'persist:wombat'

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

function backendHost() {
  try {
    return new URL(getServerUrl()).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * In-app navigation is allowed to:
 *   - the loopback app origin (normal dashboard routing)
 *   - any loopback host (Docker backend, local Keycloak at :8080)
 *   - the configured wombat-server origin (remote deployments)
 *   - hosts explicitly allowlisted via config.json or
 *     WOMBAT_ALLOWED_NAV_HOSTS (e.g. a remote Keycloak / Entra / Okta host)
 */
export function isNavigationAllowed(rawUrl, appOrigin) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.origin === appOrigin) return true

  const host = parsed.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host)) return true
  if (host === backendHost()) return true
  if (getAllowedNavigationHosts().includes(host)) return true
  return false
}

function handleNavigation(event, url, appOrigin) {
  if (isNavigationAllowed(url, appOrigin)) return
  event.preventDefault()
  if (!/^https?:/i.test(url)) return
  let host = url
  try { host = new URL(url).host } catch { /* keep raw */ }
  dialog.showMessageBox({
    type: 'question',
    message: `Open external link to ${host}?`,
    detail: String(url).slice(0, 500),
    buttons: ['Cancel', 'Open'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }).then(({ response }) => {
    if (response === 1) shell.openExternal(url).catch(() => {})
  }).catch(() => {})
}

/** Guard every renderer-initiated navigation and redirect in `win`. */
export function attachNavigationGuards(win, appOrigin) {
  const { webContents } = win

  webContents.on('will-navigate', (event, url) => handleNavigation(event, url, appOrigin))
  // Server-side redirects (SSO, /auth/callback) do not emit will-navigate.
  webContents.on('will-redirect', (event, url) => handleNavigation(event, url, appOrigin))

  webContents.setWindowOpenHandler(({ url }) => {
    // The dashboard has no in-app popups; anything asking for a new window
    // belongs in the browser.
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** Permission policy and download behaviour for the app session. */
export function configureSession(ses, appOrigin) {
  if (configuredSessions.has(ses)) return
  configuredSessions.add(ses)

  const debug = process.env.WOMBAT_DEBUG_PERMISSIONS === '1'

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (debug) console.log(`[wombat-app] permission request: ${permission} (${details?.requestingUrl ?? '?'})`)
    if (CLIPBOARD_PERMISSIONS.has(permission)) {
      callback(details?.requestingUrl?.startsWith(`${appOrigin}/`) ?? false)
      return
    }
    callback(ALLOWED_PERMISSIONS.has(permission))
  })

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (debug) console.log(`[wombat-app] permission check: ${permission} (${requestingOrigin})`)
    if (CLIPBOARD_PERMISSIONS.has(permission)) {
      return (requestingOrigin ?? '').replace(/\/+$/, '') === appOrigin
    }
    return ALLOWED_PERMISSIONS.has(permission)
  })

  ses.on('will-download', (_event, item) => {
    const filename = item.getFilename() || 'download'
    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath: path.join(app.getPath('downloads'), filename),
    })
    item.once('done', (_doneEvent, state) => {
      console.log(`[wombat-app] download ${filename}: ${state}`)
    })
  })
}

/** Global guard: this app never hosts <webview> tags. */
export function lockDownWebContents() {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
