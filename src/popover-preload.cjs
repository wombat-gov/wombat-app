/**
 * Preload for the menu-bar popover.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wombatWidgets', {
  get: () => ipcRenderer.invoke('widgets:get'),
  openDashboard: (runId) => ipcRenderer.invoke('widgets:open-dashboard', runId ?? null),
  openFindings: (runId) => ipcRenderer.invoke('widgets:open-findings', runId ?? null),
  openNotifications: () => ipcRenderer.invoke('widgets:open-notifications'),
  openStack: () => ipcRenderer.invoke('widgets:open-stack'),
  openTab: (runId) => ipcRenderer.invoke('widgets:open-tab', runId ?? null),
  startDrag: (runId) => ipcRenderer.invoke('widgets:start-drag', runId ?? null),
  copyLink: (runId) => ipcRenderer.invoke('widgets:copy-link', runId ?? null),
  setProject: (project) => ipcRenderer.invoke('widgets:set-project', project ?? ''),
  startStack: () => ipcRenderer.invoke('widgets:start-stack'),
  hide: () => ipcRenderer.invoke('widgets:hide'),
  openSettings: () => ipcRenderer.invoke('widgets:open-settings'),
  quit: () => ipcRenderer.invoke('widgets:quit'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('widgets:update', listener)
    return () => ipcRenderer.removeListener('widgets:update', listener)
  },
})
