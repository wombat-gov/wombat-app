const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('scanZone', {
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  choose: () => ipcRenderer.invoke('scan:choose'),
  chooseWatch: () => ipcRenderer.invoke('scan:choose-watch'),
  drop: (folder) => ipcRenderer.invoke('scan:drop', folder),
  watch: (folder) => ipcRenderer.invoke('scan:watch', folder),
  stopWatch: () => ipcRenderer.invoke('scan:stop-watch'),
  cancelJob: (jobId) => ipcRenderer.invoke('scan:cancel', jobId ?? ''),
  openRun: (runId) => ipcRenderer.invoke('scan:open-run', runId),
  getStatus: () => ipcRenderer.invoke('scan:get-status'),
  close: () => ipcRenderer.invoke('scan:close'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('scan:status', listener)
    return () => ipcRenderer.removeListener('scan:status', listener)
  },
  onWatch: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('scan:watch', listener)
    return () => ipcRenderer.removeListener('scan:watch', listener)
  },
})
