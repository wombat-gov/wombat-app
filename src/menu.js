/**
 * Application menu. Labels follow the system locale (en/de).
 */
import { Menu, shell } from 'electron'

import { APP_TITLE } from './config.js'
import { getLocale, translate } from './i18n.js'

export function buildMenu({
  getWindow,
  onOpenSettings,
  onShowLogs,
  onCheckUpdates,
  onNewWindow,
  onPrint,
  onSavePdf,
  onOpenHelp,
}) {
  const locale = getLocale()
  const t = key => translate(locale, key)

  const template = [
    {
      label: APP_TITLE,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: t('menu.settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => onOpenSettings?.(),
        },
        {
          label: t('menu.checkUpdates'),
          click: () => onCheckUpdates?.(),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => onNewWindow?.(),
        },
        { type: 'separator' },
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: () => onPrint?.(),
        },
        {
          label: 'Export Page as PDF…',
          click: () => onSavePdf?.(),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: t('menu.help'),
          click: () => onOpenHelp?.(),
        },
        { type: 'separator' },
        {
          label: t('menu.openInBrowser'),
          click: () => {
            const win = getWindow()
            if (!win) return
            const url = win.webContents.getURL()
            if (/^https?:/i.test(url)) shell.openExternal(url)
          },
        },
        {
          label: t('menu.showLogs'),
          click: () => onShowLogs?.(),
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
