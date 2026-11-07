/**
 * First-run tour and What's New state (UI Wave U5).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, ipcMain } from 'electron'

import { getPreferences, savePreferences } from './config.js'
import { logger } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readWhatsNew() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'whats-new.json'), 'utf8'))
  } catch (error) {
    logger.warn('whats-new read failed', { message: String(error) })
    return { version: app.getVersion(), items: [] }
  }
}

function state({ forceOnboarding = false, forceWhatsNew = false } = {}) {
  const version = app.getVersion()
  const prefs = getPreferences()
  const skipped = process.env.WOMBAT_SKIP_ONBOARDING === '1'
  const whatsNew = readWhatsNew()
  return {
    version,
    showOnboarding: !skipped && (forceOnboarding || !prefs.onboardingVersion),
    showWhatsNew: !skipped && (forceWhatsNew || (!forceOnboarding && prefs.onboardingVersion && prefs.whatsNewSeen !== version)),
    items: Array.isArray(whatsNew.items) ? whatsNew.items : [],
    whatsNewVersion: whatsNew.version || version,
  }
}

function complete(kind) {
  const version = app.getVersion()
  if (kind === 'onboarding') {
    savePreferences({ onboardingVersion: version, whatsNewSeen: version })
  } else {
    savePreferences({ whatsNewSeen: version })
  }
  const payload = state()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('shell:onboarding-done', payload)
    } catch {
      /* window is going away */
    }
  }
  return payload
}

function show(kind) {
  const payload = state({
    forceOnboarding: kind === 'onboarding',
    forceWhatsNew: kind === 'whatsnew',
  })
  const target = typeof getTargetWindow === 'function' ? getTargetWindow() : null
  const windows = target && !target.isDestroyed() ? [target] : BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('shell:onboarding', payload)
    } catch {
      /* window is going away */
    }
  }
  return payload
}

let registered = false

export function registerOnboardingIpc({ getTargetWindow = null } = {}) {
  if (registered) return
  registered = true
  ipcMain.handle('onboarding:get', () => state())
  ipcMain.handle('onboarding:complete', (_event, kind) => complete(kind === 'whatsnew' ? 'whatsnew' : 'onboarding'))
  ipcMain.handle('onboarding:show', (_event, kind) => show(kind === 'onboarding' ? 'onboarding' : 'whatsnew'))
  ipcMain.handle('onboarding:reset', (_event, kind) => {
    if (kind === 'onboarding') savePreferences({ onboardingVersion: '' })
    else savePreferences({ whatsNewSeen: '' })
    return state()
  })
}
