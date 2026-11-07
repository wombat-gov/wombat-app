const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stackApi', {
  get: () => ipcRenderer.invoke('stack:get'),
  action: (name, action) => ipcRenderer.invoke('stack:action', name, action),
  logs: (name) => ipcRenderer.invoke('stack:logs', name),
  start: () => ipcRenderer.invoke('stack:start'),
  openDashboard: () => ipcRenderer.invoke('stack:open-dashboard'),
  close: () => ipcRenderer.invoke('stack:close'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('stack:update', listener)
    return () => ipcRenderer.removeListener('stack:update', listener)
  },
})
