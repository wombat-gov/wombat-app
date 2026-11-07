/**
 * Live stack console and container log viewer.
 *
 * Everything goes through the Docker CLI, so it works the same on macOS,
 * Windows and Linux. Container names are strictly whitelisted.
 */
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'

import { getActiveEnvironment, getPreferences } from './config.js'
import { resolveDockerBinary, startDockerStack, waitForHealth } from './docker-stack.js'
import { logger } from './logger.js'
import { registerShellWindow } from './theme.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const NAME_RE = /^(waf-|wombat)/i
const ANSI_RE = /\u001b\[[0-9;]*m/g

let stackWindow = null
let logsWindow = null
let logsReady = false
let statsTimer = null
let logChild = null
let logContainer = ''
let statsCache = { at: 0, data: null }
let statsInFlight = null

function runDocker(args, options = {}) {
  return execFileAsync(resolveDockerBinary(), args, { timeout: 10_000, ...options })
}

async function collectContainers() {
  try {
    const { stdout } = await runDocker(['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.State}}'])
    const containers = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, status, state] = line.split('\t')
        return { name, status, state: String(state || '').toLowerCase() }
      })
      .filter(container => NAME_RE.test(container.name))
    return { available: true, containers, error: null }
  } catch (error) {
    return {
      available: false,
      containers: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function collectStats() {
  if (statsCache.data && Date.now() - statsCache.at < 2_000) return statsCache.data
  if (statsInFlight) return statsInFlight

  statsInFlight = (async () => {
    try {
      const { stdout } = await runDocker(
        ['stats', '--no-stream', '--format', '{{json .}}'],
        { timeout: 15_000 },
      )
      const map = {}
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        try {
          const row = JSON.parse(line)
          map[row.Name] = {
            cpu: Number.parseFloat(String(row.CPUPerc).replace('%', '')) || 0,
            memPct: Number.parseFloat(String(row.MemPerc).replace('%', '')) || 0,
            mem: row.MemUsage || '',
            net: row.NetIO || '',
            block: row.BlockIO || '',
            pids: row.PIDs || '',
          }
        } catch {
          /* skip malformed line */
        }
      }
      statsCache = { at: Date.now(), data: map }
      return map
    } catch {
      return {}
    } finally {
      statsInFlight = null
    }
  })()

  return statsInFlight
}

async function getStackData() {
  const [listing, stats] = await Promise.all([collectContainers(), collectStats()])
  return {
    generatedAt: new Date().toISOString(),
    environment: getActiveEnvironment()?.name ?? '',
    canStartStack: Boolean(getPreferences().dockerComposePath?.trim()),
    stats,
    ...listing,
  }
}

export function createStack({ navigate }) {
  function ensureStackWindow() {
    if (stackWindow && !stackWindow.isDestroyed()) return stackWindow

    stackWindow = new BrowserWindow({
      width: 580,
      height: 700,
      minWidth: 480,
      minHeight: 480,
      show: false,
      title: 'WOMBATpass Stack',
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(__dirname, 'stack-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    registerShellWindow(stackWindow)
    stackWindow.once('ready-to-show', () => stackWindow.show())
    stackWindow.on('closed', () => {
      stackWindow = null
      stopStats()
    })
    stackWindow.loadFile(path.join(__dirname, 'stack.html'))
    return stackWindow
  }

  function ensureLogsWindow() {
    if (logsWindow && !logsWindow.isDestroyed()) return logsWindow

    logsWindow = new BrowserWindow({
      width: 760,
      height: 560,
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: 'Container logs',
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(__dirname, 'logs-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    registerShellWindow(logsWindow)
    logsWindow.once('ready-to-show', () => logsWindow.show())
    logsWindow.webContents.on('did-finish-load', () => {
      logsReady = true
    })
    logsWindow.on('closed', () => {
      logsWindow = null
      logsReady = false
      killLogStream()
    })
    logsWindow.loadFile(path.join(__dirname, 'logs.html'))
    return logsWindow
  }

  function startStats() {
    if (statsTimer) return
    statsTimer = setInterval(async () => {
      if (!stackWindow || stackWindow.isDestroyed() || !stackWindow.isVisible()) return
      const data = await getStackData()
      if (stackWindow && !stackWindow.isDestroyed()) {
        stackWindow.webContents.send('stack:update', data)
      }
    }, 2_000)
  }

  function stopStats() {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
  }

  function killLogStream() {
    if (logChild) {
      try {
        logChild.kill()
      } catch {
        /* ignore */
      }
      logChild = null
    }
    logContainer = ''
  }

  function openLogs(name) {
    if (!NAME_RE.test(name)) return { ok: false, error: 'Unknown container' }

    const win = ensureLogsWindow()
    win.show()
    win.focus()
    killLogStream()
    logContainer = name

    const startStreaming = () => {
      if (!logsWindow || logsWindow.isDestroyed()) return
      logsWindow.webContents.send('logs:init', { container: name })

      try {
        logChild = spawn(
          resolveDockerBinary(),
          ['logs', '-f', '--tail', '400', '--timestamps', name],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        logsWindow.webContents.send('logs:line', { text: `Could not start docker logs: ${error.message}`, error: true })
        return
      }

      const forward = (chunk) => {
        const text = chunk.toString().replace(ANSI_RE, '')
        for (const line of text.split('\n')) {
          if (line && logsWindow && !logsWindow.isDestroyed()) {
            logsWindow.webContents.send('logs:line', { text: line })
          }
        }
      }
      logChild.stdout?.on('data', forward)
      logChild.stderr?.on('data', forward)
      logChild.on('exit', () => {
        if (logsWindow && !logsWindow.isDestroyed()) {
          logsWindow.webContents.send('logs:end', { container: name })
        }
        logChild = null
      })

      logger.info('container logs opened', { container: name })
    }

    if (logsReady) startStreaming()
    else win.webContents.once('did-finish-load', startStreaming)

    return { ok: true }
  }

  async function containerAction(name, action) {
    if (!NAME_RE.test(name)) return { ok: false, error: 'Unknown container' }
    if (!['restart', 'stop', 'start'].includes(action)) return { ok: false, error: 'Unknown action' }

    if (action === 'stop' || action === 'restart') {
      const environment = getActiveEnvironment()
      const production = environment?.kind === 'production'
      const detail = action === 'stop'
        ? 'The service will be unavailable until it is started again.'
        : 'The service will be briefly unavailable.'
      const { response } = await dialog.showMessageBox({
        type: production ? 'error' : 'warning',
        message: `${action === 'stop' ? 'Stop' : 'Restart'} ${name}?`,
        detail: production
          ? `${detail}\n\nThis is the PRODUCTION environment (${environment.name}).`
          : detail,
        buttons: ['Cancel', action === 'stop' ? 'Stop' : 'Restart'],
        defaultId: production ? 0 : 1,
        cancelId: 0,
        noLink: true,
      })
      if (response !== 1) return { ok: false, cancelled: true }
    }

    try {
      await runDocker([action, name], { timeout: 60_000 })
      logger.info('container action', { name, action })
      statsCache = { at: 0, data: null }
      return { ok: true }
    } catch (error) {
      logger.error('container action failed', { name, action, message: error.message })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function startStack() {
    const result = await startDockerStack()
    if (!result.ok) {
      const message = result.error === 'no-path'
        ? 'Set the Docker Compose path in Server Settings.'
        : result.error === 'no-compose'
          ? 'No docker-compose.yml in the configured path.'
          : result.error
      return { ok: false, message }
    }
    const healthy = await waitForHealth()
    statsCache = { at: 0, data: null }
    return { ok: true, healthy, message: healthy ? 'Stack is up' : 'Started, but /health timed out' }
  }

  ipcMain.handle('stack:get', () => getStackData())
  ipcMain.handle('stack:action', (_event, name, action) => containerAction(name, action))
  ipcMain.handle('stack:logs', (_event, name) => openLogs(name))
  ipcMain.handle('stack:start', () => startStack())
  ipcMain.handle('stack:open-dashboard', () => {
    navigate({ runId: null, route: 'dashboard' })
    return { ok: true }
  })
  ipcMain.handle('stack:close', () => {
    stackWindow?.hide()
    return { ok: true }
  })

  ipcMain.handle('logs:copy', async (_event, text) => {
    await clipboard.writeText(String(text ?? ''))
    return { ok: true }
  })
  ipcMain.handle('logs:close', () => {
    logsWindow?.hide()
    return { ok: true }
  })
  ipcMain.handle('logs:current', () => ({ container: logContainer }))

  return {
    open() {
      const win = ensureStackWindow()
      win.show()
      win.focus()
      getStackData().then((data) => {
        if (stackWindow && !stackWindow.isDestroyed()) stackWindow.webContents.send('stack:update', data)
      })
      startStats()
      return win
    },
    openLogs,
    startStack,
    destroy() {
      stopStats()
      killLogStream()
      stackWindow?.destroy()
      logsWindow?.destroy()
      stackWindow = null
      logsWindow = null
    },
  }
}
