/**
 * Update state machine (UI Wave U4).
 *
 * Manifest: { version, notes?, url?, sha256?, size? }
 *
 * States: idle | checking | available | downloading | ready | error.
 * Downloads go to a temp folder, are size-capped and SHA-256 verified, and are
 * only opened after an explicit confirmation. No silent installation.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'

import { getPreferences, savePreferences } from './config.js'
import { patchState } from './desktop-state.js'
import { logger } from './logger.js'
import { tt } from './i18n.js'
import { publishToast } from './toasts.js'

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const PROGRESS_THROTTLE_MS = 200

let updateState = {
  state: 'idle',
  current: app.getVersion(),
  latest: '',
  notes: '',
  url: '',
  sha256: '',
  size: 0,
  progress: 0,
  downloadedBytes: 0,
  filePath: '',
  error: '',
  upToDate: false,
  checkedAt: null,
}
let abortController = null
let lastProgressAt = 0

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(value => Number.parseInt(value, 10) || 0)
  const pb = String(b).replace(/^v/i, '').split('.').map(value => Number.parseInt(value, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

function snapshot() {
  return structuredClone(updateState)
}

function broadcast() {
  const payload = snapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('updates:state', payload)
    } catch {
      /* window is going away */
    }
  }
  patchState({
    update: {
      state: payload.state,
      current: payload.current,
      latest: payload.latest,
      progress: payload.progress,
      error: payload.error,
    },
  })
}

function setState(patch) {
  updateState = { ...updateState, ...patch, current: app.getVersion() }
  broadcast()
  return snapshot()
}

export function getUpdateState() {
  return snapshot()
}

function allowedUrl(raw) {
  try {
    const url = new URL(String(raw))
    if (url.protocol === 'https:') return url.toString()
    if (url.protocol === 'http:') {
      const host = url.hostname.toLowerCase()
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
        return url.toString()
      }
    }
    return ''
  } catch {
    return ''
  }
}

function updateFileName(url) {
  try {
    const base = path.basename(new URL(url).pathname) || 'wombatpass-update'
    return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  } catch {
    return 'wombatpass-update'
  }
}

function configuredFeed() {
  const preferences = getPreferences()
  const beta = String(preferences.updateFeedUrlBeta ?? '').trim()
  if (preferences.updateChannel === 'beta' && beta) return beta
  return String(preferences.updateFeedUrl ?? '').trim()
}

export async function checkForUpdates({ silent = false, feed = null, force = false } = {}) {
  if (updateState.state === 'downloading') {
    return { ok: false, reason: 'busy' }
  }
  if (!force) {
    const preferences = getPreferences()
    if (preferences.updateSnoozeUntil && new Date(preferences.updateSnoozeUntil).getTime() > Date.now()) {
      return { ok: false, reason: 'snoozed' }
    }
  }

  const rawFeed = String(feed ?? configuredFeed() ?? '').trim()
  savePreferences({ updateLastChecked: new Date().toISOString() })
  const feedUrl = allowedUrl(rawFeed)
  if (!feedUrl) {
    const message = rawFeed ? 'The update feed must be HTTPS (or localhost HTTP).' : 'No update feed configured.'
    setState({ state: 'idle', error: message, checkedAt: new Date().toISOString() })
    if (!silent) {
      publishToast({
        level: 'warning',
        title: 'Update check',
        body: message,
        action: { kind: 'settings', tab: 'advanced' },
        key: 'update-no-feed',
      })
    }
    return { ok: false, reason: 'no-feed', error: message }
  }

  setState({ state: 'checking', error: '', checkedAt: new Date().toISOString() })
  try {
    const response = await fetch(feedUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest = await response.json()

    const latest = String(manifest.version ?? '').replace(/^v/i, '')
    if (!latest) throw new Error('manifest has no version')
    if (response.url && !allowedUrl(response.url)) throw new Error('The update feed redirected to a non-HTTPS URL.')
    const downloadUrl = allowedUrl(manifest.url)
    if (!downloadUrl) throw new Error('manifest has no valid HTTPS download URL')

    const current = app.getVersion()
    if (compareVersions(latest, current) <= 0) {
      setState({
        state: 'idle',
        latest,
        notes: String(manifest.notes ?? ''),
        url: '',
        sha256: '',
        size: 0,
        progress: 0,
        filePath: '',
        upToDate: true,
        error: '',
        checkedAt: new Date().toISOString(),
      })
      return { ok: true, update: false, current }
    }

    setState({
      state: 'available',
      latest,
      notes: String(manifest.notes ?? ''),
      url: downloadUrl,
      sha256: String(manifest.sha256 ?? '').toLowerCase(),
      size: Number(manifest.size) || 0,
      progress: 0,
      downloadedBytes: 0,
      filePath: '',
      upToDate: false,
      error: '',
      checkedAt: new Date().toISOString(),
    })

    publishToast({
      level: 'info',
      title: tt('toast.updateAvailableTitle', 'Update available: {version}', { version: latest }),
      body: String(manifest.notes ?? `Installed version ${current}.`).slice(0, 300),
      action: { kind: 'settings', tab: 'advanced' },
      key: `update:${latest}`,
      ttl: 12_000,
    })
    logger.info('update available', { current, latest })
    return { ok: true, update: true, latest }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setState({ state: 'error', error: message, checkedAt: new Date().toISOString() })
    logger.warn('update check failed', { message })
    if (!silent) {
      publishToast({
        level: 'error',
        title: tt('toast.updateCheckFailedTitle', 'Update check failed'),
        body: message.slice(0, 300),
        action: { kind: 'settings', tab: 'advanced' },
        key: 'update-check-error',
      })
    }
    return { ok: false, error: message }
  }
}

export async function downloadUpdate() {
  if (updateState.state !== 'available' || !updateState.url) {
    return { ok: false, error: 'No update is available to download.' }
  }
  if (updateState.size > MAX_DOWNLOAD_BYTES) {
    const message = 'The update is larger than the allowed limit.'
    setState({ state: 'error', error: message })
    return { ok: false, error: message }
  }

  const dir = path.join(app.getPath('temp'), 'wombatpass-updates')
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, updateFileName(updateState.url))
  await fsp.rm(filePath, { force: true }).catch(() => {})

  lastProgressAt = 0
  abortController = new AbortController()
  const controller = abortController
  setState({
    state: 'downloading',
    progress: 0,
    downloadedBytes: 0,
    filePath,
    error: '',
  })

  try {
    const response = await fetch(updateState.url, {
      headers: { accept: 'application/octet-stream' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.url && !allowedUrl(response.url)) throw new Error('The update download redirected to a non-HTTPS URL.')
    const contentLength = Number(response.headers.get('content-length')) || 0
    if (contentLength > MAX_DOWNLOAD_BYTES) throw new Error('The update is larger than the allowed limit.')
    if (!response.body) throw new Error('The update response has no body.')

    const hash = createHash('sha256')
    let received = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > MAX_DOWNLOAD_BYTES) {
          callback(new Error('The update is larger than the allowed limit.'))
          return
        }
        hash.update(chunk)
        const now = Date.now()
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now
          const total = updateState.size || contentLength || 0
          setState({
            progress: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
            downloadedBytes: received,
          })
        }
        callback(null, chunk)
      },
    })

    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(filePath))
    if (controller.signal.aborted) throw new Error('Download cancelled.')

    const digest = hash.digest('hex').toLowerCase()
    if (updateState.sha256 && digest !== updateState.sha256) {
      await fsp.rm(filePath, { force: true }).catch(() => {})
      throw new Error('The downloaded update failed SHA-256 verification.')
    }
    if (updateState.size && received !== updateState.size) {
      await fsp.rm(filePath, { force: true }).catch(() => {})
      throw new Error('The downloaded update size does not match the manifest.')
    }

    setState({
      state: 'ready',
      progress: 100,
      downloadedBytes: received,
      filePath,
      error: '',
    })
    publishToast({
      level: 'success',
      title: tt('toast.updateDownloadedTitle', 'Update downloaded'),
      body: tt('toast.updateDownloadedBody', '{version} is ready to install.', { version: updateState.latest }),
      action: { kind: 'update-open' },
      key: `update-ready:${updateState.latest}`,
      ttl: 12_000,
    })
    logger.info('update downloaded', { latest: updateState.latest, bytes: received })
    return { ok: true, filePath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fsp.rm(filePath, { force: true }).catch(() => {})
    if (controller.signal.aborted) {
      setState({ state: 'available', error: 'Download cancelled.', progress: 0, downloadedBytes: 0 })
      return { ok: false, canceled: true }
    }
    setState({ state: 'error', error: message, progress: 0, downloadedBytes: 0 })
    logger.warn('update download failed', { message })
    return { ok: false, error: message }
  } finally {
    if (abortController === controller) abortController = null
  }
}

export function cancelUpdateDownload() {
  abortController?.abort()
  abortController = null
  if (updateState.state === 'downloading') {
    setState({ state: 'available', progress: 0, downloadedBytes: 0, error: 'Download cancelled.' })
  }
  return { ok: true }
}

export async function openDownloadedUpdate() {
  if (updateState.state !== 'ready' || !updateState.filePath) {
    return { ok: false, error: 'No downloaded update is ready.' }
  }
  if (!fs.existsSync(updateState.filePath)) {
    setState({ state: 'error', error: 'The downloaded file is missing. Download it again.' })
    return { ok: false, error: 'missing' }
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `Open the installer for ${updateState.latest || 'the update'}?`,
    detail: updateState.filePath,
    buttons: ['Cancel', 'Open'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  })
  if (response !== 1) return { ok: false, canceled: true }

  const error = await shell.openPath(updateState.filePath)
  if (error) return { ok: false, error }
  return { ok: true }
}

export function snoozeUpdate(hours = 24) {
  const until = new Date(Date.now() + Math.max(1, Number(hours) || 24) * 3_600_000).toISOString()
  savePreferences({ updateSnoozeUntil: until })
  return { ok: true, until }
}

export function showDownloadedUpdate() {
  if (updateState.filePath && fs.existsSync(updateState.filePath)) {
    shell.showItemInFolder(updateState.filePath)
    return { ok: true }
  }
  return { ok: false, error: 'No downloaded update found.' }
}

let registered = false

export function registerUpdateIpc() {
  if (registered) return
  registered = true
  ipcMain.handle('updates:get', () => getUpdateState())
  ipcMain.handle('updates:check', (_event, feed) => checkForUpdates({ feed: feed ? String(feed) : null, force: true }))
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:cancel', () => cancelUpdateDownload())
  ipcMain.handle('updates:open', () => openDownloadedUpdate())
  ipcMain.handle('updates:snooze', (_event, hours) => snoozeUpdate(hours))
  ipcMain.handle('updates:show', () => showDownloadedUpdate())
}
