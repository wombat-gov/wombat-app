/**
 * In-app toast service (UI Wave U2).
 *
 * Main process publishes short-lived notifications to every dashboard window.
 * Dedupe keys prevent SSE + polling + controller callbacks from showing the
 * same event twice. OS notifications remain a separate, independently
 * configurable channel (tray.js).
 */
import { BrowserWindow } from 'electron'

import { getPreferences } from './config.js'
import { logger } from './logger.js'

const DEDUPE_WINDOW_MS = 10_000
let sequence = 0
const recent = new Map()

function prune(now) {
  for (const [key, at] of recent) {
    if (now - at > DEDUPE_WINDOW_MS) recent.delete(key)
  }
}

export function publishToast({
  level = 'info',
  title = '',
  body = '',
  action = null,
  actionLabel = '',
  ttl = 6_000,
  key = '',
} = {}) {
  try {
    if (getPreferences().showToasts === false) return null
  } catch {
    /* preferences unavailable during startup: still show */
  }
  if (!title && !body) return null

  const now = Date.now()
  prune(now)
  const dedupeKey = key || `${level}:${title}:${body}`.slice(0, 300)
  if (recent.has(dedupeKey)) return null
  recent.set(dedupeKey, now)

  const toast = {
    id: `toast-${now}-${++sequence}`,
    level: ['success', 'info', 'warning', 'error'].includes(level) ? level : 'info',
    title: String(title),
    body: String(body || ''),
    action: action && typeof action === 'object' ? action : null,
    actionLabel: String(actionLabel || '').slice(0, 40),
    ttl: Number.isFinite(ttl) ? Math.max(2_000, Math.min(30_000, ttl)) : 6_000,
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('shell:toast', toast)
    } catch {
      /* window is going away */
    }
  }
  logger.info('toast published', { level: toast.level, title: toast.title })
  return toast
}
