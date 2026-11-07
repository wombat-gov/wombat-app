/**
 * Desktop device authorization (server Wave D).
 *
 * Main-process only: starts the device flow against the selected environment,
 * opens the browser approval page, polls for the token, and stores it with
 * Electron's safeStorage (Keychain / DPAPI / libsecret). Tokens never cross
 * into a renderer; the dashboard authenticates through the loopback proxy,
 * which injects `Authorization: Bearer …` for the active environment.
 */
import { safeStorage, shell } from 'electron'

import {
  deleteDeviceAuthRecord,
  getDeviceAuthRecord,
  setDeviceAuthRecord,
} from './config.js'
import { logger } from './logger.js'

const DEVICE_NO_BROWSER = process.env.WOMBAT_DEVICE_NO_BROWSER === '1'
const MAX_POLL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure token storage is unavailable on this system.')
  }
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(record) {
  if (!record?.tokenEnc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(String(record.tokenEnc), 'base64'))
  } catch {
    return ''
  }
}

/** A valid stored token for this environment, or '' if absent/mismatched. */
export function getStoredDeviceToken(environmentId, url) {
  const record = getDeviceAuthRecord(environmentId)
  if (!record?.tokenEnc) return ''
  if (url && normalizeUrl(record.url) !== normalizeUrl(url)) return ''
  return decryptToken(record)
}

export function getDeviceStatus(environmentId, url) {
  const record = getDeviceAuthRecord(environmentId)
  if (!record?.tokenEnc) return { signedIn: false }
  if (url && normalizeUrl(record.url) !== normalizeUrl(url)) return { signedIn: false }
  const token = decryptToken(record)
  return {
    signedIn: Boolean(token),
    username: record.username || '',
    deviceName: record.deviceName || '',
    deviceId: record.deviceId || '',
    savedAt: record.savedAt || '',
    url: record.url || '',
  }
}

function signalWithTimeout(signal) {
  if (signal) return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

async function fetchJson(url, init, signal) {
  const response = await fetch(url, { ...init, signal: signalWithTimeout(signal) })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, ok: response.ok, headers: response.headers, body }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

function detailMessage(detail) {
  switch (detail) {
    case 'access_denied': return 'The request was denied in the browser.'
    case 'expired_token': return 'The approval code expired. Start sign-in again.'
    case 'invalid_grant': return 'The sign-in code is no longer valid. Start again.'
    default: return typeof detail === 'string' ? detail : 'Sign-in failed.'
  }
}

export function createDeviceAuth({ onStatus, onSignedIn } = {}) {
  const sessions = new Map()

  function emit(payload) {
    try {
      onStatus?.(payload)
    } catch (error) {
      logger.warn('device auth status', { message: String(error) })
    }
  }

  function cancel(environmentId) {
    const state = sessions.get(environmentId)
    if (!state) return
    state.cancelled = true
    try {
      state.controller.abort()
    } catch { /* already aborted */ }
    sessions.delete(environmentId)
  }

  function cancelAll() {
    for (const id of [...sessions.keys()]) cancel(id)
  }

  async function signIn({ environmentId, url, deviceName }) {
    const base = normalizeUrl(url)
    if (!base) return { ok: false, message: 'Enter a valid http(s) server URL first.' }

    cancel(environmentId)
    const controller = new AbortController()
    const state = { controller, cancelled: false }
    sessions.set(environmentId, state)

    const fail = (message, extra = {}) => {
      emit({ environmentId, state: 'error', message, ...extra })
      return { ok: false, message, ...extra }
    }

    try {
      const started = await fetchJson(`${base}/api/v1/auth/device/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          device_name: String(deviceName || 'WOMBATpass Desktop').slice(0, 100),
          client: `wombatpass-desktop/${process.platform}`,
        }),
      }, controller.signal)

      if (started.status === 404) {
        return fail('This server does not support desktop device sign-in. Update wombat-server to Wave D.')
      }
      if (started.status === 429) {
        return fail('Too many sign-in attempts. Wait a minute and try again.')
      }
      if (!started.ok || !started.body?.device_code) {
        const detail = started.body?.detail
        return fail(typeof detail === 'string' ? detail : `Could not start sign-in (HTTP ${started.status}).`)
      }

      const { device_code: deviceCode, user_code: userCode, verification_url: verificationUrl } = started.body
      const interval = Math.max(2, Number(started.body.interval) || 5)
      const expiresIn = Math.max(30, Number(started.body.expires_in) || 600)

      emit({
        environmentId,
        state: 'waiting',
        message: `Approve in your browser — code ${userCode}`,
        userCode,
        verificationUrl,
      })

      if (!DEVICE_NO_BROWSER && verificationUrl) {
        shell.openExternal(verificationUrl).catch((error) => {
          logger.warn('device auth open browser', { message: String(error) })
        })
      }

      const deadline = Date.now() + Math.min(expiresIn * 1000, MAX_POLL_MS)
      let pollSeconds = interval

      while (Date.now() < deadline) {
        await sleep(pollSeconds * 1000, controller.signal)
        if (state.cancelled) return { ok: false, cancelled: true, message: 'Sign-in cancelled.' }

        const polled = await fetchJson(`${base}/api/v1/auth/device/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ device_code: deviceCode }),
        }, controller.signal)

        if (polled.status === 200 && polled.body?.device_token) {
          let tokenEnc
          try {
            tokenEnc = encryptToken(polled.body.device_token)
          } catch (error) {
            return fail(error instanceof Error ? error.message : 'Could not store the device token securely.')
          }

          const record = {
            tokenEnc,
            url: base,
            deviceId: polled.body.device?.id ?? '',
            deviceName: polled.body.device?.name || deviceName || 'WOMBATpass Desktop',
            username: polled.body.user?.username || '',
            savedAt: new Date().toISOString(),
          }
          setDeviceAuthRecord(environmentId, record)
          logger.info('device auth signed in', {
            environment: environmentId,
            device: record.deviceId,
            user: record.username,
          })

          const result = {
            ok: true,
            environmentId,
            username: record.username,
            deviceName: record.deviceName,
            deviceId: record.deviceId,
            message: `Signed in as ${record.username || 'user'}.`,
          }
          emit({ environmentId, state: 'success', ...result })
          try {
            onSignedIn?.({ environmentId, ...result })
          } catch { /* non-fatal */ }
          return result
        }

        const detail = polled.body?.detail
        if (polled.status === 429) {
          const retryAfter = Number(polled.headers.get('retry-after')) || interval + 2
          pollSeconds = Math.max(pollSeconds, retryAfter)
          continue
        }
        if (polled.status === 400 && detail === 'authorization_pending') continue
        if (polled.status === 400 && detail === 'slow_down') {
          pollSeconds += 5
          continue
        }
        if (polled.status === 404) {
          return fail('This server does not support desktop device sign-in.')
        }
        return fail(detailMessage(detail))
      }

      return fail('The approval code expired. Start sign-in again.')
    } catch (error) {
      if (controller.signal.aborted || state.cancelled) {
        return { ok: false, cancelled: true, message: 'Sign-in cancelled.' }
      }
      logger.warn('device auth failed', { message: error instanceof Error ? error.message : String(error) })
      return fail(`Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (sessions.get(environmentId) === state) sessions.delete(environmentId)
    }
  }

  async function signOut({ environmentId, url }) {
    const record = getDeviceAuthRecord(environmentId)
    if (!record?.tokenEnc) return { ok: true, message: 'Not signed in.' }

    const base = normalizeUrl(url || record.url)
    const token = decryptToken(record)
    let warning = ''
    if (token && record.deviceId && base && normalizeUrl(record.url) === base) {
      try {
        const response = await fetch(`${base}/api/v1/auth/devices/${encodeURIComponent(record.deviceId)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok && response.status !== 404) {
          warning = ` The server returned HTTP ${response.status}; the token was removed locally.`
        }
      } catch {
        warning = ' The server could not be reached; the token was removed locally.'
      }
    }

    deleteDeviceAuthRecord(environmentId)
    logger.info('device auth signed out', { environment: environmentId })
    return { ok: true, message: `Signed out.${warning}` }
  }

  return { signIn, signOut, cancel, cancelAll, getStatus: getDeviceStatus }
}
