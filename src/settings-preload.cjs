/**
 * Preload for the server-settings window.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wombatSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  test: (url) => ipcRenderer.invoke('settings:test', url),
  detect: () => ipcRenderer.invoke('settings:detect'),
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
  deviceSignIn: (payload) => ipcRenderer.invoke('settings:device-sign-in', payload),
  devices: () => ipcRenderer.invoke('settings:devices'),
  revokeDevice: (deviceId) => ipcRenderer.invoke('settings:device-revoke', { deviceId }),
  sessions: () => ipcRenderer.invoke('settings:sessions'),
  revokeSession: (sessionId) => ipcRenderer.invoke('settings:session-revoke', sessionId),
  sessionsRevokeAll: () => ipcRenderer.invoke('settings:sessions-revoke-all'),
  confirm: (options) => ipcRenderer.invoke('settings:confirm', options),
  setTheme: (theme, persist = true) => ipcRenderer.invoke('shell:set-theme', theme, persist),
  setLocale: (locale, persist = true) => ipcRenderer.invoke('shell:set-locale', locale, persist),
  openScan: () => ipcRenderer.invoke('settings:open-scan'),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  clearPaletteRecents: () => ipcRenderer.invoke('palette:clear-recents'),
  updatesGet: () => ipcRenderer.invoke('updates:get'),
  updatesCheck: (feed) => ipcRenderer.invoke('updates:check', feed ?? ''),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesCancel: () => ipcRenderer.invoke('updates:cancel'),
  updatesOpen: () => ipcRenderer.invoke('updates:open'),
  updatesSnooze: (hours) => ipcRenderer.invoke('updates:snooze', hours ?? 24),
  updatesShow: () => ipcRenderer.invoke('updates:show'),
  showOnboarding: (kind) => ipcRenderer.invoke('onboarding:show', kind ?? 'onboarding'),
  setDirty: (dirty) => ipcRenderer.invoke('settings:set-dirty', Boolean(dirty)),
  testAll: () => ipcRenderer.invoke('settings:test-all'),
  relaunch: () => ipcRenderer.invoke('settings:relaunch'),
  clearLocalData: () => ipcRenderer.invoke('settings:clear-local-data'),
  devicesRevokeAll: () => ipcRenderer.invoke('settings:devices-revoke-all'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('updates:state', listener)
    return () => ipcRenderer.removeListener('updates:state', listener)
  },
  deviceSignOut: (payload) => ipcRenderer.invoke('settings:device-sign-out', payload),
  deviceCancel: () => ipcRenderer.invoke('settings:device-cancel'),
  openExternal: (url) => ipcRenderer.invoke('settings:open-external', url),
  onOpenTab: (callback) => {
    const listener = (_event, tab) => callback(tab)
    ipcRenderer.on('settings:open-tab', listener)
    return () => ipcRenderer.removeListener('settings:open-tab', listener)
  },
  onI18n: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('shell:i18n', listener)
    return () => ipcRenderer.removeListener('shell:i18n', listener)
  },
  onDeviceStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('settings:device-status', listener)
    return () => ipcRenderer.removeListener('settings:device-status', listener)
  },
  showLogs: () => ipcRenderer.invoke('settings:show-logs'),
  close: () => ipcRenderer.invoke('settings:close'),
})
