const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wombatHelp', {
  get: () => ipcRenderer.invoke('help:get'),
  health: () => ipcRenderer.invoke('help:health'),
  openExternal: (url) => ipcRenderer.invoke('help:open-external', url),
  showLogs: () => ipcRenderer.invoke('help:show-logs'),
  openConfig: () => ipcRenderer.invoke('help:open-config'),
  copy: (text) => ipcRenderer.invoke('help:copy', text),
  diagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),
  saveDiagnostics: () => ipcRenderer.invoke('diagnostics:save'),
  openAbout: () => ipcRenderer.invoke('help:open-about'),
  saveSbom: () => ipcRenderer.invoke('help:save-sbom'),
  saveSupport: () => ipcRenderer.invoke('help:save-support'),
  onOpenTab: (callback) => {
    const listener = (_event, tab) => callback(tab)
    ipcRenderer.on('help:open-tab', listener)
    return () => ipcRenderer.removeListener('help:open-tab', listener)
  },
  close: () => ipcRenderer.invoke('help:close'),
})
