/**
 * Global shortcuts. Registered centrally so they can be unregistered on quit
 * and so conflicts are logged in one place.
 */
import { globalShortcut } from 'electron'

import { logger } from './logger.js'

const registered = []

function register(accelerator, handler, label) {
  try {
    if (globalShortcut.register(accelerator, handler)) {
      registered.push(accelerator)
    } else {
      logger.warn('global shortcut unavailable', { accelerator, label })
    }
  } catch (error) {
    logger.warn('global shortcut error', {
      accelerator,
      label,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function registerShortcuts({
  togglePopover,
  openDashboard,
  scanClipboard,
  openPalette,
  openDropZone,
  newWindow,
}) {
  register('CommandOrControl+Shift+W', () => togglePopover?.(), 'widgets')
  register('CommandOrControl+Shift+D', () => openDashboard?.(), 'dashboard')
  register('CommandOrControl+Shift+S', () => scanClipboard?.(), 'clipboard scan')
  register('CommandOrControl+Shift+K', () => openPalette?.(), 'command palette')
  register('CommandOrControl+Shift+O', () => openDropZone?.(), 'scan folder')
  register('CommandOrControl+Shift+N', () => newWindow?.(), 'new window')
}

export function unregisterShortcuts() {
  for (const accelerator of registered.splice(0)) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      /* ignore */
    }
  }
}
