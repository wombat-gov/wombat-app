/**
 * Shell theme system (UI Wave U0).
 *
 * The dashboard keeps its own theme and the in-page app bar inherits its CSS
 * variables. Standalone shell windows (Settings, palette, Help, scan zone,
 * logs, tray popover, stack console, quick scan) are fixed-dark today; this
 * module applies a shared light/high-contrast token layer to them at runtime
 * via `webContents.insertCSS`, so no HTML/CSP changes are needed.
 */
import { ipcMain, nativeTheme } from 'electron'

import { getPreferences, savePreferences } from './config.js'
import { patchState } from './desktop-state.js'
import { logger } from './logger.js'

const VALID_MODES = new Set(['system', 'light', 'dark'])
const windows = new Set()

let initialized = false
let registered = false
let updatedListener = null

const SHELL_THEME_CSS = `
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f5f7fa;
    --surface: #ffffff;
    --surface-2: #eef2f7;
    --border: #d5dde6;
    --text: #17202b;
    --muted: #5b6b7c;
    --accent: #2563eb;
    --ok: #1a7f37;
    --warn: #9a6700;
    --err: #cf222e;
    --error: #cf222e;
  }
  :root[data-theme="light"] body { background: var(--bg); color: var(--text); }
  /* Brand blue with white text is below AA on the dark accent; dark ink passes. */
  :root[data-theme="dark"] button.primary { color: #0b0f14; }

  :root[data-theme="dark"][data-contrast="high"] {
    --border: #8fa0b5;
    --muted: #d7e1ec;
    --surface-2: #222c38;
  }
  :root[data-theme="light"][data-contrast="high"] {
    --border: #475569;
    --muted: #334155;
    --surface: #ffffff;
    --surface-2: #e2e8f0;
    --text: #0b1220;
  }

  :root[data-reduced-motion="reduce"] *,
  :root[data-reduced-motion="reduce"] *::before,
  :root[data-reduced-motion="reduce"] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  :focus-visible {
    outline: 2px solid var(--accent, #4f8cff);
    outline-offset: 2px;
  }
`

function envTheme() {
  const value = String(process.env.WOMBAT_THEME ?? '').trim().toLowerCase()
  return VALID_MODES.has(value) ? value : null
}

export function getThemeMode() {
  const stored = getPreferences().theme
  return envTheme() ?? (VALID_MODES.has(stored) ? stored : 'system')
}

export function getThemeState() {
  return {
    mode: getThemeMode(),
    effective: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    highContrast: Boolean(nativeTheme.shouldUseHighContrastColors),
    reducedMotion: Boolean(nativeTheme.shouldUseReducedMotion),
  }
}

function setThemeAttributes(win, theme) {
  if (!win || win.isDestroyed()) return
  const script = `(() => {
    const root = document.documentElement;
    root.dataset.theme = ${JSON.stringify(theme.effective)};
    root.dataset.contrast = ${JSON.stringify(theme.highContrast ? 'high' : 'normal')};
    root.dataset.reducedMotion = ${JSON.stringify(theme.reducedMotion ? 'reduce' : 'no-preference')};
  })()`
  win.webContents.executeJavaScript(script, true).catch(() => {})
  if (!win.isDestroyed()) {
    win.webContents.send('shell:theme', { ...theme, mode: getThemeMode() })
  }
}

export function applyThemeToWindow(win) {
  if (!win || win.isDestroyed()) return
  const theme = getThemeState()
  try {
    win.setBackgroundColor(theme.effective === 'dark' ? '#0b0f14' : '#f5f7fa')
  } catch {
    /* some window types ignore background changes */
  }
  win.webContents.insertCSS(SHELL_THEME_CSS).catch(() => {})
  setThemeAttributes(win, theme)
}

export function registerShellWindow(win) {
  if (!win || win.isDestroyed() || windows.has(win)) return win
  windows.add(win)
  win.on('closed', () => windows.delete(win))
  win.webContents.on('did-finish-load', () => applyThemeToWindow(win))
  if (!win.webContents.isLoading()) applyThemeToWindow(win)
  return win
}

export function broadcastTheme() {
  const theme = getThemeState()
  patchState({
    ui: {
      theme: theme.mode,
      effectiveTheme: theme.effective,
      highContrast: theme.highContrast,
      reducedMotion: theme.reducedMotion,
    },
  })
  for (const win of [...windows]) {
    if (!win || win.isDestroyed()) {
      windows.delete(win)
      continue
    }
    applyThemeToWindow(win)
  }
}

export function setThemeMode(rawMode, { persist = true } = {}) {
  const mode = VALID_MODES.has(String(rawMode)) ? String(rawMode) : 'system'
  if (persist) {
    try {
      savePreferences({ theme: mode })
    } catch (error) {
      logger.warn('theme preference save', { message: String(error) })
    }
  }
  nativeTheme.themeSource = mode
  broadcastTheme()
  return getThemeState()
}

function registerIpc() {
  if (registered) return
  registered = true
  ipcMain.handle('shell:get-theme', () => getThemeState())
  ipcMain.handle('shell:set-theme', (_event, mode, persist) => setThemeMode(mode, { persist: persist !== false }))
}

export function initTheme() {
  if (initialized) return
  initialized = true
  nativeTheme.themeSource = getThemeMode()
  registerIpc()

  updatedListener = () => broadcastTheme()
  nativeTheme.on('updated', updatedListener)

  const theme = getThemeState()
  patchState({
    ui: {
      theme: theme.mode,
      effectiveTheme: theme.effective,
      highContrast: theme.highContrast,
      reducedMotion: theme.reducedMotion,
    },
  })
}

export function stopTheme() {
  if (updatedListener) nativeTheme.off('updated', updatedListener)
  updatedListener = null
  windows.clear()
}
