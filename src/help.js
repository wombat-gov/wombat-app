/**
 * Help & About window: runtime info, shortcuts, SBOM overview, diagnostics.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'

import { getActiveEnvironment, getConfigPath, getPreferences, getServerUrl, readConfig } from './config.js'
import { collectDiagnostics } from './diagnostics.js'
import { getMessages } from './i18n.js'
import { getLogPath } from './logger.js'
import { registerShellWindow } from './theme.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let window = null

function readSbom() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'sbom.json'), 'utf8'))
  } catch {
    return null
  }
}

function readWhatsNew() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'whats-new.json'), 'utf8'))
  } catch {
    return { version: app.getVersion(), items: [] }
  }
}

function sbomCdxPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sbom.cdx.json')
    : path.resolve(__dirname, '..', 'build', 'sbom.cdx.json')
}

export function createHelp({ navigate }) {
  ipcMain.handle('help:get', () => ({
    app: { name: app.getName(), version: app.getVersion() },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: { os: process.platform, arch: process.arch, release: os.release() },
    environment: getActiveEnvironment(),
    serverUrl: getServerUrl(),
    configPath: getConfigPath(),
    logPath: getLogPath(),
    preferences: getPreferences(),
    i18n: getMessages(),
    sbom: readSbom(),
    whatsNew: readWhatsNew(),
    crash: {
      count: Number(readConfig().crashLoopCount) || 0,
      at: readConfig().crashLoopAt || null,
    },
  }))

  ipcMain.handle('help:health', async () => {
    const url = getServerUrl()
    const started = performance.now()
    try {
      const response = await fetch(`${url}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
      })
      const latencyMs = Math.round(performance.now() - started)
      return { ok: response.ok, status: response.status, latencyMs }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('help:open-external', async (_event, url) => {
    const value = String(url ?? '')
    if (!/^https?:\/\//i.test(value)) return { ok: false }
    await shell.openExternal(value)
    return { ok: true }
  })

  ipcMain.handle('help:show-logs', () => {
    const logPath = getLogPath()
    if (logPath) shell.showItemInFolder(logPath)
    return { ok: Boolean(logPath) }
  })

  ipcMain.handle('help:open-config', () => {
    shell.showItemInFolder(getConfigPath())
    return { ok: true }
  })

  ipcMain.handle('help:copy', async (_event, text) => {
    await clipboard.writeText(String(text ?? ''))
    return { ok: true }
  })

  ipcMain.handle('help:open-about', () => {
    navigate({ route: 'about' })
    return { ok: true }
  })

  ipcMain.handle('help:save-sbom', async (event) => {
    const source = sbomCdxPath()
    if (!fs.existsSync(source)) return { ok: false, error: 'SBOM file not found.' }

    const owner = BrowserWindow.fromWebContents(event.sender) ?? window ?? undefined
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Save SBOM (CycloneDX)',
      defaultPath: path.join(app.getPath('documents'), `wombatpass-sbom-${app.getVersion()}.cdx.json`),
      filters: [{ name: 'CycloneDX JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    try {
      await fs.promises.copyFile(source, filePath)
      shell.showItemInFolder(filePath)
      return { ok: true, filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('help:save-support', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? window
    if (!owner) return { ok: false }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Save support bundle',
      defaultPath: path.join(app.getPath('documents'), `wombatpass-support-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const diagnostics = collectDiagnostics()
      await fs.promises.writeFile(filePath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8')
      const image = await owner.webContents.capturePage()
      const screenshotPath = filePath.replace(/\.json$/i, '') + '-screen.png'
      await fs.promises.writeFile(screenshotPath, image.toPNG())
      return { ok: true, filePath, screenshotPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('help:close', () => {
    window?.hide()
    return { ok: true }
  })

  function open(tab = null) {
    if (window && !window.isDestroyed()) {
      window.show()
      window.focus()
      if (tab) window.webContents.send('help:open-tab', tab)
      return window
    }

    window = new BrowserWindow({
      width: 790,
      height: 680,
      minWidth: 640,
      minHeight: 480,
      title: 'Help & About',
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(__dirname, 'help-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    registerShellWindow(window)
    window.on('closed', () => {
      window = null
    })
    window.loadFile(path.join(__dirname, 'help.html'))
    if (tab) {
      window.webContents.once('did-finish-load', () => {
        window?.webContents.send('help:open-tab', tab)
      })
    }
    return window
  }

  return {
    open,
    destroy() {
      window?.destroy()
      window = null
    },
  }
}
