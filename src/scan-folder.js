/**
 * Scan a local IaC folder without bind mounts.
 *
 * The app stages the relevant IaC files, `docker cp`s them into the server
 * container under its scan base directory, calls POST /api/v1/scan, and cleans
 * up. Works on macOS, Windows and Linux with only the Docker CLI.
 *
 * Also provides a simple cross-platform folder watcher (polling) that triggers
 * a scan after IaC files change.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserWindow, Notification, dialog, ipcMain } from 'electron'

import { appFetch } from './app-api.js'
import { resolveDockerBinary } from './docker-stack.js'
import { patchState } from './desktop-state.js'
import { tt } from './i18n.js'
import { upsertScanJob } from './scan-state.js'
import { publishToast } from './toasts.js'
import { logger } from './logger.js'
import { registerShellWindow } from './theme.js'
import { SESSION_PARTITION } from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

const CONTAINER_SCAN_ROOT = '.desktop-scans'
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const MAX_FILES = 4_000
const MAX_BYTES = 100 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set([
  '.tf', '.tfvars', '.hcl', '.yaml', '.yml', '.json', '.template', '.bicep',
])
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.terraform', '.venv', 'venv', 'dist', 'build',
  'release', 'target', '.next', '.idea', '.vscode', '__pycache__', 'coverage', '__MACOSX',
])

let window = null
let watcher = null
let watchBusy = false
let lastStatus = { status: 'idle' }
let scanning = false
let originForScan = ''

function runDocker(args, options = {}) {
  return execFileAsync(resolveDockerBinary(), args, { timeout: 15_000, ...options })
}

function isIacFile(name) {
  if (name.startsWith('._') || name === '.DS_Store') return false
  if (name.endsWith('.pulumi.yaml') || name.endsWith('.cdk.json')) return true
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

async function collectFiles(root) {
  const files = []
  let bytes = 0

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
      } else if (entry.isFile() && isIacFile(entry.name)) {
        const stat = await fsp.stat(full)
        bytes += stat.size
        if (bytes > MAX_BYTES) {
          throw new Error(`Folder is too large (>${Math.round(MAX_BYTES / 1024 / 1024)} MB of IaC files).`)
        }
        files.push({ abs: full, rel: path.relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }

  await walk(root)
  return files
}

function detectIac(files) {
  const names = files.map(file => file.rel.toLowerCase())
  if (names.some(name => name.endsWith('.tf') || name.endsWith('.tfvars'))) return 'terraform'
  if (names.some(name => name.endsWith('.template') || name.endsWith('.yaml') || name.endsWith('.yml'))) return 'cloudformation'
  return 'terraform'
}


async function stageFiles(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wombat-scan-'))
  for (const file of files) {
    const target = path.join(dir, file.rel)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(file.abs, target)
  }
  return dir
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function findServerContainer() {
  try {
    const { stdout } = await runDocker(['ps', '--format', '{{.Names}}'])
    const names = stdout.trim().split('\n').map(name => name.trim()).filter(Boolean)
    return names.find(name => /wombat-server/i.test(name)) ?? names.find(name => /wombat/i.test(name)) ?? null
  } catch (error) {
    logger.warn('scan: docker unavailable', { message: error.message })
    return null
  }
}

async function fetchScanStatus() {
  try {
    const response = await appFetch(originForScan, '/api/v1/scan/status')
    if (response.status === 401) return { error: 'auth' }
    if (!response.ok) return { error: `HTTP ${response.status}` }
    return await response.json()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function ensureWindow() {
  if (window && !window.isDestroyed()) return window

  window = new BrowserWindow({
    width: 460,
    height: 360,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Scan an IaC folder',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'scan-zone-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  registerShellWindow(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    window = null
  })
  window.loadFile(path.join(__dirname, 'scan-zone.html'))
  return window
}

function sendStatus(status) {
  lastStatus = status
  patchState({
    scan: {
      running: status.status === 'busy' ? 1 : 0,
    },
  })
  if (status.status === 'error') {
    publishToast({ level: 'error', title: tt('toast.scanFailedTitle', 'Scan failed'), body: String(status.message || 'Scan failed.'), key: `scan-failed:${status.jobId || status.message || ''}` })
  }
  if (window && !window.isDestroyed()) window.webContents.send('scan:status', status)
  if (watcher && window && !window.isDestroyed()) {
    window.webContents.send('scan:watch', { dir: watcher.dir })
  }
}

export function createScanFolder({ origin, navigate }) {
  originForScan = origin

  function setOrigin(next) {
    originForScan = next
  }

  let jobsSupport = { at: 0, ok: false }

  async function supportsJobs() {
    if (Date.now() - jobsSupport.at < 60_000) return jobsSupport.ok
    try {
      const response = await appFetch(originForScan, '/api/v1/scans?limit=1')
      const ok = response.status === 200
      jobsSupport = { at: Date.now(), ok }
      return ok
    } catch {
      return false
    }
  }

  function scanDoneStatus(folder, project, files, iac, source, run) {
    publishToast({
      level: 'success',
      title: tt('toast.scanCompleteTitle', 'Scan complete: {project}', { project: run.project ?? project }),
      body: tt('toast.scanCompleteBody', 'Score {score}/100 · {files} IaC files', { score: run.score ?? '—', files }),
      action: { kind: 'run', id: run.id },
      key: `scan-complete:${run.id}`,
    })
    sendStatus({
      status: 'done',
      folder,
      project,
      files,
      iac,
      progress: 100,
      run: { id: run.id, project: run.project ?? project, score: run.score ?? null },
      source,
    })
  }

  async function pollJob(job, context) {
    const { folder, project, files, iac, source } = context
    const deadline = Date.now() + 15 * 60 * 1000
    let current = job

    while (Date.now() < deadline) {
      if (current.status === 'succeeded') {
        let run = { id: current.run_id, project: current.project ?? project, score: null }
        try {
          const response = await appFetch(originForScan, `/api/v1/runs/${current.run_id}`)
          if (response.ok) {
            const json = await response.json()
            run = { id: json.data.id, project: json.data.project, score: json.data.score }
          }
        } catch {
          /* score is optional */
        }
        logger.info('scan job succeeded', { job: current.id, run: run.id, project })
        scanDoneStatus(folder, project, files, iac, source, run)
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: tt('toast.scanCompleteTitle', 'Scan complete: {project}', { project: run.project }),
            body: tt('toast.scanCompleteBody', 'Score {score}/100 · {files} IaC files', { score: run.score ?? '—', files }),
          })
          notification.on('click', () => navigate({ runId: run.id }))
          notification.show()
        }
        return { ok: true, run, folder }
      }

      if (current.status === 'failed') {
        const message = current.error || 'Scan failed.'
        logger.error('scan job failed', { job: current.id, message })
        sendStatus({ status: 'error', message, jobId: current.id })
        if (Notification.isSupported()) {
          new Notification({ title: tt('toast.scanFailedTitle', 'Scan failed'), body: message.slice(0, 180) }).show()
        }
        return { ok: false, error: message }
      }

      if (current.status === 'cancelled') {
        sendStatus({ status: 'error', message: 'Scan cancelled.' })
        return { ok: false, reason: 'cancelled' }
      }

      sendStatus({
        status: 'scanning',
        folder,
        project,
        files,
        iac,
        progress: Number.isFinite(current.progress) ? current.progress : 0,
        jobId: current.id,
        source,
      })
      await sleep(1_000)

      const response = await appFetch(originForScan, `/api/v1/scans/${encodeURIComponent(current.id)}`)
      if (response.status === 404) return { ok: false, reason: 'unsupported' }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      current = (await response.json()).data
      upsertScanJob(current)
    }

    throw new Error('Scan job timed out.')
  }

  async function scanFolderViaJob(folder, files, { project, iac, source }) {
    let staging = null
    let archive = null
    try {
      staging = await stageFiles(files)
      archive = `${staging}.tar.gz`
      try {
        await execFileAsync('tar', ['-czf', archive, '-C', staging, '.'], {
          timeout: 60_000,
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        })
      } catch (error) {
        // No tar available (or it failed) — let the Docker path handle it.
        logger.warn('tar unavailable for upload', { message: error instanceof Error ? error.message : String(error) })
        return { ok: false, reason: 'unsupported' }
      }

      const blob = new Blob([await fsp.readFile(archive)], { type: 'application/gzip' })
      const form = new FormData()
      form.append('file', blob, 'wombat-scan.tar.gz')
      form.append('project', project)
      form.append('iac', iac)
      form.append('stage', source === 'watch' ? 'watch' : 'desktop')

      const response = await appFetch(originForScan, '/api/v1/scans/upload', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(180_000),
      })

      if (response.status === 401) {
        sendStatus({ status: 'auth' })
        return { ok: false, reason: 'auth' }
      }
      if (response.status === 404 || response.status === 405) {
        return { ok: false, reason: 'unsupported' }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail ?? `HTTP ${response.status}`)
      }

      const job = (await response.json()).data
      upsertScanJob(job)
      logger.info('scan job created', { job: job.id, project, files: files.length, source })
      return await pollJob(job, { folder, project, files: files.length, iac, source })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('upload scan failed', { message })
      sendStatus({ status: 'error', message })
      if (Notification.isSupported()) {
        new Notification({ title: tt('toast.scanFailedTitle', 'Scan failed'), body: message.slice(0, 180) }).show()
      }
      return { ok: false, error: message }
    } finally {
      if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
      if (archive) await fsp.rm(archive, { force: true }).catch(() => {})
    }
  }

  async function scanFolder(folder, { watch = false, source = 'desktop' } = {}) {
    if (scanning) {
      sendStatus({ status: 'busy', message: 'A scan is already running.' })
      return { ok: false, reason: 'busy' }
    }

    const resolved = path.resolve(folder)
    try {
      const stat = await fsp.stat(resolved)
      if (!stat.isDirectory()) throw new Error('Not a folder')
    } catch {
      sendStatus({ status: 'error', message: `Not a folder: ${resolved}` })
      return { ok: false }
    }

    scanning = true
    let staging = null
    let containerPath = null
    let container = null

    try {
      const serverStatus = await fetchScanStatus()
      if (serverStatus?.error === 'auth') {
        sendStatus({ status: 'auth' })
        return { ok: false, reason: 'auth' }
      }
      if (serverStatus?.error) {
        sendStatus({ status: 'error', message: `Server scan status: ${serverStatus.error}` })
        return { ok: false }
      }
      if (serverStatus && serverStatus.enabled === false) {
        sendStatus({ status: 'error', message: 'Server-side scanning is disabled (WOMBAT_SCAN_ENABLED).' })
        return { ok: false }
      }
      if (serverStatus && serverStatus.engine_available === false) {
        sendStatus({ status: 'error', message: 'The Wombat scan engine is not available in the server container.' })
        return { ok: false }
      }

      const files = await collectFiles(resolved)
      if (files.length === 0) {
        sendStatus({ status: 'error', message: 'No IaC files (.tf, .yaml, .json, …) found in that folder.' })
        return { ok: false }
      }

      const project = path.basename(resolved)
      const iac = detectIac(files)

      // Wave B: upload + asynchronous job (no Docker required).
      if (await supportsJobs()) {
        const jobResult = await scanFolderViaJob(resolved, files, { project, iac, source })
        if (jobResult.reason !== 'unsupported') {
          if (jobResult.ok && watch) startWatching(resolved)
          return jobResult
        }
      }

      // Fallback for older servers: copy into the running container.
      container = await findServerContainer()
      if (!container || !NAME_RE.test(container)) {
        sendStatus({ status: 'error', message: 'wombat-server container not found. Is the Docker stack running?' })
        return { ok: false }
      }

      const base = path.posix.resolve('/app', String(serverStatus?.scan_base_dir || '/app'))
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      containerPath = `${base}/${CONTAINER_SCAN_ROOT}/${id}`

      sendStatus({
        status: 'scanning',
        folder: resolved,
        project,
        files: files.length,
        iac,
        progress: 10,
        source,
      })

      staging = await stageFiles(files)

      try {
        await runDocker(['exec', '-u', '0', container, 'mkdir', '-p', `${base}/${CONTAINER_SCAN_ROOT}`], { timeout: 10_000 })
      } catch {
        /* already exists or image runs as root */
      }
      await runDocker(['cp', staging, `${container}:${containerPath}`], { timeout: 120_000 })
      // docker cp writes as the invoking user; make the copy readable by the
      // server process (which usually runs as a non-root user).
      await runDocker(['exec', '-u', '0', container, 'chmod', '-R', 'a+rX', containerPath], { timeout: 30_000 })

      sendStatus({
        status: 'scanning',
        folder: resolved,
        project,
        files: files.length,
        iac,
        progress: 60,
        source,
      })

      const response = await appFetch(originForScan, '/api/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: containerPath,
          iac,
          project,
          branch: '',
          stage: source === 'watch' ? 'watch' : 'desktop',
          triggered_by: 'desktop',
        }),
        signal: AbortSignal.timeout(180_000),
      })

      if (response.status === 401) {
        sendStatus({ status: 'auth' })
        return { ok: false, reason: 'auth' }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail ?? `HTTP ${response.status}`)
      }

      const json = await response.json()
      const run = json.data ?? json
      scanDoneStatus(resolved, project, files.length, iac, source, run)
      logger.info('folder scan complete', { project, files: files.length, run: run.id, source })

      if (Notification.isSupported()) {
        const notification = new Notification({
          title: `Scan complete: ${run.project ?? project}`,
          body: `Score ${run.score ?? '—'}/100 · ${files.length} IaC files`,
        })
        notification.on('click', () => navigate({ runId: run.id }))
        notification.show()
      }

      if (watch) startWatching(resolved)
      return { ok: true, run, folder: resolved }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('folder scan failed', { message })
      sendStatus({ status: 'error', message })
      if (Notification.isSupported()) {
        new Notification({ title: 'Scan failed', body: message.slice(0, 180) }).show()
      }
      return { ok: false, error: message }
    } finally {
      scanning = false
      if (container && containerPath) {
        try {
          await runDocker(['exec', '-u', '0', container, 'rm', '-rf', containerPath], { timeout: 15_000 })
        } catch (error) {
          logger.warn('scan cleanup failed', { message: error instanceof Error ? error.message : String(error) })
        }
      }
      if (staging) {
        try {
          await fsp.rm(staging, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }

  function requireTempDir() {
    return os.tmpdir()
  }

  // ── Watch mode (polling, cross-platform) ────────────────────────────────
  function fileSignature(files) {
    return files.map(file => `${file.rel}:${file.size}:${file.mtimeMs}`).join('|')
  }

  async function watchTick() {
    if (!watcher || watchBusy || scanning) return
    watchBusy = true
    try {
      const files = await collectFiles(watcher.dir)
      const signature = fileSignature(files)
      if (watcher.signature && signature !== watcher.signature) {
        watcher.signature = signature
        logger.info('watch change detected', { dir: watcher.dir })
        if (Notification.isSupported()) {
          new Notification({ title: 'WOMBATpass watch', body: `Change detected in ${path.basename(watcher.dir)} — scanning…` }).show()
        }
        await scanFolder(watcher.dir, { source: 'watch' })
      } else {
        watcher.signature = signature
      }
    } catch (error) {
      logger.warn('watch tick failed', { message: error instanceof Error ? error.message : String(error) })
    } finally {
      watchBusy = false
    }
  }

  async function startWatching(folder) {
    stopWatching()
    const resolved = path.resolve(folder)
    watcher = { dir: resolved, signature: null, timer: null }

    // Establish a baseline without triggering a scan.
    try {
      const files = await collectFiles(resolved)
      if (watcher) watcher.signature = fileSignature(files)
    } catch {
      /* the first tick will establish it */
    }

    if (!watcher) return { ok: false }
    watcher.timer = setInterval(watchTick, 3_000)
    patchState({ scan: { watching: { active: true, path: resolved } } })
    if (window && !window.isDestroyed()) window.webContents.send('scan:watch', { dir: resolved })
    publishToast({ level: 'info', title: tt('toast.watchingFolderTitle', 'Watching folder'), body: resolved, key: `watch-start:${resolved}` })
    logger.info('watching folder', { dir: resolved })
    return { ok: true }
  }

  function stopWatching() {
    const wasWatching = Boolean(watcher)
    if (watcher?.timer) clearInterval(watcher.timer)
    watcher = null
    patchState({ scan: { watching: { active: false, path: '' } } })
    if (wasWatching) publishToast({ level: 'info', title: tt('toast.stoppedWatching', 'Stopped watching folder') })
    if (window && !window.isDestroyed()) window.webContents.send('scan:watch', { dir: null })
    return { ok: true }
  }

  async function cancelJob(jobId) {
    if (!jobId) return { ok: false }
    try {
      const response = await appFetch(originForScan, `/api/v1/scans/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return { ok: false, message: body.detail ?? `HTTP ${response.status}` }
      }
      logger.info('scan job cancellation requested', { job: jobId })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  function open() {
    const win = ensureWindow()
    win.show()
    win.focus()
    if (watcher) win.webContents.send('scan:watch', { dir: watcher.dir })
    win.webContents.send('scan:status', lastStatus)
    return win
  }

  async function chooseWatch() {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose an IaC folder to watch',
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    await scanFolder(result.filePaths[0], { watch: true })
    return { ok: true, folder: result.filePaths[0] }
  }

  ipcMain.handle('scan:get-status', () => ({ status: lastStatus, watching: watcher?.dir ?? null }))
  ipcMain.handle('scan:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose an IaC folder',
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    return scanFolder(result.filePaths[0])
  })
  ipcMain.handle('scan:choose-watch', () => chooseWatch())
  ipcMain.handle('scan:drop', (_event, folder) => scanFolder(String(folder)))
  ipcMain.handle('scan:watch', (_event, folder) => startWatching(String(folder)))
  ipcMain.handle('scan:stop-watch', () => stopWatching())
  ipcMain.handle('scan:cancel', (_event, jobId) => cancelJob(String(jobId ?? '')))
  ipcMain.handle('scan:open-run', (_event, runId) => {
    navigate({ runId })
    return { ok: true }
  })
  ipcMain.handle('scan:close', () => {
    window?.hide()
    return { ok: true }
  })

  return {
    setOrigin,
    open,
    scanFolder,
    cancelJob,
    chooseWatch,
    startWatching,
    stopWatching,
    isWatching: () => Boolean(watcher),
    destroy() {
      stopWatching()
      window?.destroy()
      window = null
    },
  }
}
