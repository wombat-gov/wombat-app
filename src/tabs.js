/**
 * Cross-platform tab model (UI Wave U5).
 *
 * macOS keeps native tab groups. Windows/Linux (and `WOMBAT_UI_TABS=1` for
 * testing) use an injected strip and keep background tabs alive as hidden
 * BrowserWindows, preserving each renderer's state.
 */
import { BrowserWindow, ipcMain } from 'electron'

import { readConfig, writeConfig } from './config.js'
import { logger } from './logger.js'

const MAX_TABS = 8

export function customTabsEnabled() {
  if (process.env.WOMBAT_UI_TABS === '1') return true
  if (process.env.WOMBAT_UI_TABS === '0') return false
  return process.platform !== 'darwin'
}

export function createTabs({ openWindow, onActivate, onError, onNotice, onClosed } = {}) {
  const enabled = customTabsEnabled()
  const tabs = new Map()
  let activeId = null
  let nextId = 1
  let shuttingDown = false

  const noop = {
    enabled: false,
    register: () => null,
    activate: () => ({ ok: false }),
    close: () => ({ ok: false }),
    closeOthers: () => ({ ok: false }),
    closeToRight: () => ({ ok: false }),
    reorder: () => ({ ok: false }),
    move: () => ({ ok: false }),
    update: () => ({ ok: false }),
    newTab: async () => ({ ok: false }),
    getTabs: () => [],
    broadcast: () => {},
    restore: () => {},
    shutdown: () => {},
  }
  if (!enabled) return noop

  function tabFor(win) {
    for (const tab of tabs.values()) if (tab.win === win) return tab
    return null
  }

  function persist() {
    if (shuttingDown) return
    try {
      const list = [...tabs.values()]
      writeConfig({
        openTabs: list.map(tab => ({
          route: tab.route || 'dashboard',
          runId: tab.runId || null,
          title: tab.title || '',
        })),
        activeTabIndex: Math.max(0, list.findIndex(tab => tab.id === activeId)),
      })
    } catch (error) {
      logger.warn('tabs persist', { message: String(error) })
    }
  }

  function payload() {
    return {
      enabled: true,
      activeId,
      tabs: [...tabs.values()].map(tab => ({
        id: tab.id,
        title: tab.title || tab.route || 'Tab',
        route: tab.route,
        runId: tab.runId,
      })),
    }
  }

  function broadcast() {
    const data = payload()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('shell:tabs', data)
      } catch {
        /* window is going away */
      }
    }
  }

  function activate(id) {
    const target = tabs.get(String(id))
    if (!target || target.win.isDestroyed()) return { ok: false }
    for (const tab of tabs.values()) {
      if (tab.id === target.id) continue
      if (!tab.win.isDestroyed()) tab.win.hide()
    }
    activeId = target.id
    if (target.win.isMinimized()) target.win.restore()
    target.win.show()
    target.win.focus()
    onActivate?.(target.win)
    broadcast()
    persist()
    return { ok: true }
  }

  function activateNext(delta) {
    const list = [...tabs.values()]
    if (list.length < 2) return
    const index = list.findIndex(tab => tab.id === activeId)
    const next = list[(index + delta + list.length) % list.length]
    if (next) activate(next.id)
  }

  function removeTab(id) {
    const tab = tabs.get(String(id))
    if (!tab) return
    tabs.delete(tab.id)
    if (activeId === tab.id) {
      const next = [...tabs.values()].pop() ?? null
      activeId = next?.id ?? null
      if (next) activate(next.id)
      else {
        onActivate?.(null)
        broadcast()
      }
    } else {
      broadcast()
    }
    persist()
  }

  function close(id) {
    const tab = tabs.get(String(id))
    if (!tab) return { ok: false }
    const meta = { route: tab.route, runId: tab.runId, title: tab.title }
    try {
      tab.win.close()
    } catch {
      removeTab(tab.id)
    }
    onClosed?.(meta)
    return { ok: true }
  }

  function register(win, meta = {}) {
    const id = String(nextId++)
    const tab = {
      id,
      win,
      route: String(meta.route || 'dashboard'),
      runId: meta.runId ? String(meta.runId) : null,
      title: String(meta.title || meta.route || 'Dashboard').slice(0, 80),
    }
    tabs.set(id, tab)
    activeId = id
    if (tabs.size === 6) onNotice?.(6)

    win.on('focus', () => {
      if (activeId === id) return
      activeId = id
      onActivate?.(win)
      broadcast()
    })
    win.on('closed', () => removeTab(id))

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (!input.control && !input.meta) return
      const key = String(input.key || '')
      if (key === 'Tab') {
        event.preventDefault()
        activateNext(input.shift ? -1 : 1)
      } else if (key.toLowerCase() === 't') {
        event.preventDefault()
        newTab({ route: 'dashboard' })
      } else if (key.toLowerCase() === 'w') {
        event.preventDefault()
        close(id)
      }
    })

    broadcast()
    persist()
    return id
  }

  function update(win, meta = {}) {
    const tab = tabFor(win)
    if (!tab) return { ok: false }
    if (meta.route) tab.route = String(meta.route).slice(0, 120)
    tab.runId = meta.runId ? String(meta.runId) : null
    if (meta.title) tab.title = String(meta.title).slice(0, 80)
    else if (tab.runId) tab.title = 'Run'
    else tab.title = tab.route || 'Dashboard'
    persist()
    broadcast()
    return { ok: true }
  }

  function reorder(id, targetIndex) {
    const list = [...tabs.values()]
    const index = list.findIndex(tab => tab.id === String(id))
    if (index < 0) return { ok: false }
    const target = Math.max(0, Math.min(list.length - 1, Number(targetIndex) || 0))
    const [tab] = list.splice(index, 1)
    list.splice(target, 0, tab)
    tabs.clear()
    for (const entry of list) tabs.set(entry.id, entry)
    broadcast()
    persist()
    return { ok: true }
  }

  function move(id, delta) {
    const list = [...tabs.values()]
    const index = list.findIndex(tab => tab.id === String(id))
    if (index < 0) return { ok: false }
    return reorder(id, index + (Number(delta) || 0))
  }

  function closeOthers(id) {
    for (const tab of [...tabs.values()]) {
      if (tab.id !== String(id)) close(tab.id)
    }
    activate(id)
    return { ok: true }
  }

  function closeToRight(id) {
    const list = [...tabs.values()]
    const index = list.findIndex(tab => tab.id === String(id))
    if (index < 0) return { ok: false }
    for (const tab of list.slice(index + 1)) close(tab.id)
    return { ok: true }
  }

  async function newTab(meta = {}) {
    if (tabs.size >= MAX_TABS) {
      onError?.(`At most ${MAX_TABS} tabs can be open.`)
      return { ok: false, message: `At most ${MAX_TABS} tabs can be open.` }
    }
    const win = await openWindow?.(meta)
    return win ? { ok: true } : { ok: false }
  }

  function restore(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    for (const entry of entries.slice(0, MAX_TABS)) {
      openWindow?.({
        route: String(entry.route || 'dashboard'),
        runId: entry.runId ? String(entry.runId) : null,
      })
    }
  }

  ipcMain.handle('tabs:list', () => payload())
  ipcMain.handle('tabs:activate', (_event, id) => activate(id))
  ipcMain.handle('tabs:close', (_event, id) => close(id))
  ipcMain.handle('tabs:new', (_event, meta) => newTab(meta && typeof meta === 'object' ? meta : {}))
  ipcMain.handle('tabs:reorder', (_event, id, index) => reorder(id, index))
  ipcMain.handle('tabs:move', (_event, id, delta) => move(id, delta))
  ipcMain.handle('tabs:close-others', (_event, id) => closeOthers(id))
  ipcMain.handle('tabs:close-right', (_event, id) => closeToRight(id))
  ipcMain.handle('tabs:route', (event, meta) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false }
    return update(win, meta && typeof meta === 'object' ? meta : {})
  })

  return {
    enabled: true,
    register,
    activate,
    close,
    closeOthers,
    closeToRight,
    reorder,
    move,
    update,
    newTab,
    restore,
    getTabs: () => [...tabs.values()],
    broadcast,
    shutdown() { shuttingDown = true },
  }
}
