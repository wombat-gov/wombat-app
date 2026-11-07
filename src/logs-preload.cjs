const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('logsApi', {
  copy: (text) => ipcRenderer.invoke('logs:copy', text),
  close: () => ipcRenderer.invoke('logs:close'),
  current: () => ipcRenderer.invoke('logs:current'),
  onInit: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('logs:init', listener)
    return () => ipcRenderer.removeListener('logs:init', listener)
  },
  onLine: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('logs:line', listener)
    return () => ipcRenderer.removeListener('logs:line', listener)
  },
  onEnd: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('logs:end', listener)
    return () => ipcRenderer.removeListener('logs:end', listener)
  },
})
