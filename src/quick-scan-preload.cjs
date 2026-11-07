const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('quickScan', {
  get: () => ipcRenderer.invoke('quick-scan:get'),
  scan: () => ipcRenderer.invoke('quick-scan:scan'),
  copy: () => ipcRenderer.invoke('quick-scan:copy'),
  close: () => ipcRenderer.invoke('quick-scan:close'),
  openDashboard: () => ipcRenderer.invoke('quick-scan:open-dashboard'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('quick-scan:state', listener)
    return () => ipcRenderer.removeListener('quick-scan:state', listener)
  },
})
