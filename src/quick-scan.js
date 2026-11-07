/**
 * Clipboard IaC scan (⌘⇧S / Ctrl+Shift+S).
 *
 * Reads the clipboard, sends the snippet to the server's sandbox endpoint
 * (which accepts inline HCL, no server-side path needed) and shows a compact
 * result window. Works on macOS, Windows and Linux.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Notification, clipboard, dialog, ipcMain } from 'electron'

import { getPreferences, getServerUrl, savePreferences } from './config.js'
import { appFetch } from './app-api.js'
import { logger } from './logger.js'
import { registerShellWindow } from './theme.js'
import { SESSION_PARTITION } from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let window = null
let lastState = { status: 'idle' }

function detectIac(text) {
  if (/AWSTemplateFormatVersion|"Type"\s*:\s*"AWS::/i.test(text)) return 'cloudformation'
  if (/(^|\n)\s*(resource|provider|module|variable|data|locals|terraform)\s*["{]/.test(text)) return 'terraform'
  return 'terraform'
}

function summaryText(result) {
  return [
    `WOMBATpass clipboard scan — score ${result.score}/100`,
    `${result.total_pass} pass · ${result.total_fail} fail · ${result.total_skip} skip`,
    ...result.results
      .filter(item => String(item.status).toUpperCase() === 'FAIL')
      .slice(0, 10)
      .map(item => `${item.control_id} ${item.control_title} (${item.severity})`),
  ].join('\n')
}

export function createQuickScan({ origin, navigate }) {
  function ensureWindow() {
    if (window && !window.isDestroyed()) return window

    window = new BrowserWindow({
      width: 480,
      height: 580,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Clipboard scan',
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(__dirname, 'quick-scan-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        partition: SESSION_PARTITION,
      },
    })
    registerShellWindow(window)
    window.on('closed', () => {
      window = null
    })
    window.loadFile(path.join(__dirname, 'quick-scan.html'))
    return window
  }

  function send(state) {
    lastState = state
    if (window && !window.isDestroyed()) window.webContents.send('quick-scan:state', state)
  }

  async function scanClipboard() {
    const win = ensureWindow()
    win.show()
    win.focus()

    // Electron 45's main-process clipboard API is Promise-based.
    const text = String((await clipboard.readText()) ?? '')
    if (!text || text.trim().length < 10) {
      send({ status: 'error', message: 'The clipboard is empty.' })
      return { ok: false }
    }

    if (!getPreferences().clipboardScanConsent) {
      const preview = text.slice(0, 240).replace(/\s+/g, ' ').trim()
      const { response, checkboxChecked } = await dialog.showMessageBox(win, {
        type: 'question',
        message: 'Scan clipboard contents?',
        detail: `The clipboard (${text.length} characters) will be sent to ${getServerUrl()} for scanning.\n\n${preview}${text.length > 240 ? '…' : ''}`,
        buttons: ['Cancel', 'Scan'],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: 'Remember this choice',
        checkboxChecked: false,
        noLink: true,
      })
      if (response !== 1) {
        send({ status: 'idle' })
        return { ok: false, cancelled: true }
      }
      if (checkboxChecked) savePreferences({ clipboardScanConsent: true })
    }

    const iac = detectIac(text)
    send({ status: 'scanning', iac, chars: text.length })

    try {
      const response = await appFetch(origin, '/api/v1/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hcl: text, iac }),
        signal: AbortSignal.timeout(30_000),
      })

      if (response.status === 401) {
        send({ status: 'auth' })
        return { ok: false, reason: 'auth' }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        send({ status: 'error', message: body.detail ?? `HTTP ${response.status}` })
        return { ok: false }
      }

      const json = await response.json()
      const result = json.data ?? json
      send({ status: 'done', iac, result })
      logger.info('clipboard scan', { iac, score: result.score, fails: result.total_fail })

      if ((result.total_fail ?? 0) > 0 && Notification.isSupported()) {
        const notification = new Notification({
          title: `Clipboard scan: ${result.total_fail} failing`,
          body: `Score ${result.score}/100 · ${result.controls_loaded} controls`,
        })
        notification.on('click', () => {
          if (window && !window.isDestroyed()) {
            window.show()
            window.focus()
          }
        })
        notification.show()
      }
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('clipboard scan failed', { message })
      send({ status: 'error', message })
      return { ok: false }
    }
  }

  ipcMain.handle('quick-scan:get', () => lastState)
  ipcMain.handle('quick-scan:scan', () => scanClipboard())
  ipcMain.handle('quick-scan:copy', async () => {
    if (lastState.status === 'done' && lastState.result) {
      await clipboard.writeText(summaryText(lastState.result))
      return { ok: true }
    }
    return { ok: false }
  })
  ipcMain.handle('quick-scan:close', () => {
    window?.hide()
    return { ok: true }
  })
  ipcMain.handle('quick-scan:open-dashboard', () => {
    navigate({ route: 'sandbox' })
    window?.hide()
    return { ok: true }
  })

  return {
    scanClipboard,
    destroy() {
      window?.destroy()
      window = null
    },
  }
}
