const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('paletteApi', {
  get: () => ipcRenderer.invoke('palette:get'),
  i18n: () => ipcRenderer.invoke('shell:get-i18n'),
  onI18n: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('shell:i18n', listener)
    return () => ipcRenderer.removeListener('shell:i18n', listener)
  },
  search: (query, types) => ipcRenderer.invoke('palette:search', query ?? '', types ?? ''),
  record: (payload) => ipcRenderer.invoke('palette:record', payload),
  favorites: () => ipcRenderer.invoke('palette:favorites'),
  toggleFavorite: (payload) => ipcRenderer.invoke('palette:toggle-favorite', payload),
  clearRecents: () => ipcRenderer.invoke('palette:clear-recents'),
  execute: (command) => ipcRenderer.invoke('palette:execute', command),
  close: () => ipcRenderer.invoke('palette:close'),
  onOpen: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('palette:open', listener)
    return () => ipcRenderer.removeListener('palette:open', listener)
  },
  onData: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('palette:data', listener)
    return () => ipcRenderer.removeListener('palette:data', listener)
  },
})
