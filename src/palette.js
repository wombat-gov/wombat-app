/**
 * Global command palette (⌘⇧K / Ctrl+Shift+K).
 *
 * Search runs, dashboard pages, controls, environments and app actions. Data
 * is fetched through the app's proxy with the dashboard session and cached.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain, screen, session } from 'electron'

import { getActiveEnvironmentId, getEnvironments, readConfig, writeConfig } from './config.js'
import { logger } from './logger.js'
import { registerShellWindow } from './theme.js'
import { SESSION_PARTITION } from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WIDTH = 640
const HEIGHT = 460
const CACHE_TTL_MS = 60_000
const MAX_RECENT_COMMANDS = 10
const MAX_RECENT_SEARCHES = 5
const MAX_FAVORITES = 20
const RECENT_COMMAND_KINDS = new Set(['run', 'page', 'control', 'action', 'environment', 'finding'])

const PAGES = [
  ['dashboard', 'Dashboard'],
  ['findings', 'Findings'],
  ['catalogue', 'Controls Catalogue'],
  ['compliance', 'Compliance'],
  ['gapanalysis', 'Gap Analysis'],
  ['regions', 'Regions'],
  ['runs', 'Runs'],
  ['diff', 'Run Diff'],
  ['evidence', 'Evidence'],
  ['cost', 'Cost Impact'],
  ['pipelines', 'Pipelines'],
  ['waivers', 'Waivers'],
  ['risk', 'Risk Acceptance'],
  ['notifications', 'Notifications'],
  ['runscan', 'Run Scan'],
  ['sandbox', 'Sandbox'],
  ['audit', 'Audit Log'],
  ['settings', 'Settings'],
  ['about', 'About'],
]

let window = null
let cache = { at: 0, data: null }
let inFlight = null

function getRecents() {
  const stored = readConfig().paletteRecents
  return {
    commands: Array.isArray(stored?.commands) ? stored.commands.slice(0, MAX_RECENT_COMMANDS) : [],
    searches: Array.isArray(stored?.searches) ? stored.searches.slice(0, MAX_RECENT_SEARCHES) : [],
  }
}

function commandKey(command) {
  if (!command || typeof command !== 'object') return ''
  return [command.kind, command.id, command.route, command.runId, command.value].filter(Boolean).join(':')
}

function getFavorites() {
  const stored = readConfig().paletteFavorites
  return Array.isArray(stored) ? stored.slice(0, MAX_FAVORITES) : []
}

function toggleFavorite(payload) {
  const command = payload?.command
  if (!command || !RECENT_COMMAND_KINDS.has(String(command.kind))) return getFavorites()
  const key = commandKey(command)
  if (!key) return getFavorites()
  const favorites = getFavorites()
  const exists = favorites.find(item => commandKey(item.command) === key)
  const next = exists
    ? favorites.filter(item => commandKey(item.command) !== key)
    : [{
        command,
        label: String(payload.label ?? '').slice(0, 160),
        sub: String(payload.sub ?? '').slice(0, 160),
        badge: String(payload.badge ?? '').slice(0, 40),
      }, ...favorites].slice(0, MAX_FAVORITES)
  writeConfig({ paletteFavorites: next })
  return next
}

function recordRecent(payload) {
  if (!payload || typeof payload !== 'object') return getRecents()
  const recents = getRecents()
  const command = payload.command
  if (command && typeof command === 'object' && RECENT_COMMAND_KINDS.has(String(command.kind))) {
    const key = [command.kind, command.id, command.route, command.runId, command.value].filter(Boolean).join(':')
    const entry = {
      command,
      label: String(payload.label ?? '').slice(0, 160),
      sub: String(payload.sub ?? '').slice(0, 160),
      badge: String(payload.badge ?? '').slice(0, 40),
      at: new Date().toISOString(),
    }
    recents.commands = [entry, ...recents.commands.filter(item => {
      const other = item.command ?? {}
      return [other.kind, other.id, other.route, other.runId, other.value].filter(Boolean).join(':') !== key
    })].slice(0, MAX_RECENT_COMMANDS)
  }

  const search = String(payload.query ?? '').trim().slice(0, 100)
  if (search) {
    recents.searches = [{
      value: search,
      environmentId: getActiveEnvironmentId(),
      at: new Date().toISOString(),
    }, ...recents.searches.filter(item => item.value !== search)].slice(0, MAX_RECENT_SEARCHES)
  }

  writeConfig({ paletteRecents: recents })
  return recents
}

function clearRecents() {
  writeConfig({ paletteRecents: { commands: [], searches: [] } })
  return getRecents()
}

export function createPalette({ origin, getContext, getActions, onCommand }) {
  async function fetchData() {
    if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data
    if (inFlight) return inFlight

    inFlight = (async () => {
      const context = typeof getContext === 'function' ? await getContext() : {}
      const headers = { accept: 'application/json' }
      if (context?.mandant) headers['X-Mandant-Context'] = String(context.mandant)
      const ses = session.fromPartition(SESSION_PARTITION)

      const getJson = async (url) => {
        try {
          const response = await ses.fetch(url, { credentials: 'include', headers })
          if (!response.ok) return null
          return await response.json()
        } catch {
          return null
        }
      }

      // per_page is capped at 100 server-side; walk pages up to a sane limit.
      const fetchControls = async () => {
        const all = []
        for (let page = 1; page <= 5; page += 1) {
          const json = await getJson(`${origin}/api/v1/controls?page=${page}&per_page=100`)
          const items = Array.isArray(json?.data) ? json.data : []
          all.push(...items)
          const total = json?.meta?.total ?? all.length
          if (all.length >= total || items.length === 0) break
        }
        return all
      }

      const [runsJson, controlsData] = await Promise.all([
        getJson(`${origin}/api/v1/runs?limit=200`),
        fetchControls(),
      ])

      const runs = (runsJson?.data ?? []).map(run => ({
        id: run.id,
        project: run.project || run.branch || 'run',
        score: typeof run.score === 'number' ? run.score : null,
        createdAt: run.created_at,
        branch: run.branch || '',
      }))
      const controls = (controlsData ?? []).map(control => ({
        id: control.id,
        description: control.description || '',
        pillar: control.pillar || '',
        severity: control.severity || '',
      }))

      const data = {
        runs,
        controls,
        pages: PAGES.map(([route, label]) => ({ route, label })),
        actions: typeof getActions === 'function' ? getActions() : [],
        environments: getEnvironments().map(environment => ({ id: environment.id, name: environment.name })),
        activeEnvironmentId: getActiveEnvironmentId(),
        fetchedAt: new Date().toISOString(),
      }
      cache = { at: Date.now(), data }
      return data
    })()
      .catch((error) => {
        logger.warn('palette data', { message: error instanceof Error ? error.message : String(error) })
        return { runs: [], controls: [], pages: PAGES.map(([route, label]) => ({ route, label })), actions: getActions?.() ?? [], environments: [], activeEnvironmentId: '' }
      })
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }

  function position() {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const work = display.workArea
    const x = Math.round(work.x + (work.width - WIDTH) / 2)
    const y = Math.round(work.y + Math.min(160, work.height * 0.2))
    window.setPosition(x, y, false)
  }

  function ensureWindow() {
    if (window && !window.isDestroyed()) return window

    window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(__dirname, 'palette-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    registerShellWindow(window)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.on('blur', () => {
      if (!window.webContents.isDevToolsOpened()) window.hide()
    })
    window.on('closed', () => {
      window = null
    })
    window.loadFile(path.join(__dirname, 'palette.html'))
    return window
  }

  async function open() {
    const win = ensureWindow()
    const wasVisible = win.isVisible()
    position()
    // Reset any previous query before the window is shown, so typing while the
    // data request is in flight cannot be erased by a late reset.
    if (!win.isDestroyed() && !wasVisible) win.webContents.send('palette:open')
    win.show()
    win.focus()
    const data = await fetchData()
    if (!win.isDestroyed()) win.webContents.send('palette:data', { ...data, recents: getRecents(), favorites: getFavorites() })
    win.focus()
  }

  function hide() {
    window?.hide()
  }

  async function search(query, types = '') {
    const value = String(query ?? '').trim()
    if (!value) return { supported: true, items: [] }

    let context = {}
    try {
      context = (await getContext?.()) ?? {}
    } catch {
      context = {}
    }
    const headers = { accept: 'application/json' }
    if (context?.mandant) headers['X-Mandant-Context'] = String(context.mandant)

    try {
      const ses = session.fromPartition(SESSION_PARTITION)
      const typeFilter = String(types ?? '').trim()
      const typeQuery = typeFilter ? `&types=${encodeURIComponent(typeFilter)}` : ''
      const response = await ses.fetch(
        `${origin}/api/v1/search?q=${encodeURIComponent(value)}&limit=20${typeQuery}`,
        { credentials: 'include', headers, signal: AbortSignal.timeout(5_000) },
      )
      if (response.status === 404 || response.status === 501) return { supported: false }
      if (!response.ok) return { supported: true, items: [] }
      const json = await response.json()
      return { supported: true, items: Array.isArray(json.data) ? json.data : [] }
    } catch {
      return { supported: false }
    }
  }

  ipcMain.handle('palette:get', async () => ({ ...(await fetchData()), recents: getRecents(), favorites: getFavorites() }))
  ipcMain.handle('palette:search', (_event, query, types) => search(query, types))
  ipcMain.handle('palette:record', (_event, payload) => recordRecent(payload))
  ipcMain.handle('palette:favorites', () => getFavorites())
  ipcMain.handle('palette:toggle-favorite', (_event, payload) => toggleFavorite(payload))
  ipcMain.handle('palette:clear-recents', () => clearRecents())
  ipcMain.handle('palette:execute', (_event, command) => {
    if (!command || typeof command !== 'object') return { ok: false }
    const kind = String(command.kind || '')
    if (!['run', 'page', 'control', 'action', 'environment', 'finding'].includes(kind)) return { ok: false }
    hide()
    try {
      onCommand?.(command)
    } catch (error) {
      logger.error('palette command', { kind, message: error instanceof Error ? error.message : String(error) })
    }
    return { ok: true }
  })
  ipcMain.handle('palette:close', () => {
    hide()
    return { ok: true }
  })

  return {
    open,
    hide,
    destroy() {
      window?.destroy()
      window = null
    },
  }
}
