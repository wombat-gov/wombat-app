/**
 * Dashboard window preload.
 *
 * Exposes a tiny app bridge and injects the app-level menu bar above the
 * dashboard. The bar lives outside #root (and inside a shadow root), so React
 * re-renders cannot remove it and the dashboard's CSS cannot leak in.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Native window chrome (macOS hiddenInset / Windows titleBarOverlay) is applied
// by main.js. The bar becomes the drag region only when that mode is active.
const CHROME_ARG = process.argv.find(arg => arg.startsWith('--wombat-native-chrome='))
const NATIVE_CHROME = (CHROME_ARG ? CHROME_ARG.endsWith('=1') : process.env.WOMBAT_NATIVE_CHROME !== '0')
  && (process.platform === 'darwin' || process.platform === 'win32')
const TABS_ENABLED = process.env.WOMBAT_UI_TABS === '1'
  || (process.env.WOMBAT_UI_TABS !== '0' && process.platform !== 'darwin')
const TAB_STRIP_HEIGHT = TABS_ENABLED ? 28 : 0

contextBridge.exposeInMainWorld('wombatApp', {
  version: process.env.npm_package_version || '',
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  isDesktop: true,
  getShellState: () => ipcRenderer.invoke('shell:get-state'),
  onShellState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('shell:state', listener)
    return () => ipcRenderer.removeListener('shell:state', listener)
  },
  shellAction: (action) => ipcRenderer.invoke('shell:action', action ?? ''),
  switchEnvironment: (id) => ipcRenderer.invoke('shell:switch-environment', id),
  getShellTheme: () => ipcRenderer.invoke('shell:get-theme'),
  getI18n: () => ipcRenderer.invoke('shell:get-i18n'),
  getPerf: () => ipcRenderer.invoke('perf:get'),
  setLocale: (locale, persist = true) => ipcRenderer.invoke('shell:set-locale', locale, persist),
  setTheme: (theme, persist = true) => ipcRenderer.invoke('shell:set-theme', theme, persist),
  crashGet: () => ipcRenderer.invoke('crash:get'),
  crashReload: (safe) => ipcRenderer.invoke(safe ? 'crash:reload-safe' : 'crash:reload'),
  crashOpenLogs: () => ipcRenderer.invoke('crash:open-logs'),
  crashCopyDiagnostics: () => ipcRenderer.invoke('crash:copy-diagnostics'),
  crashSaveDiagnostics: () => ipcRenderer.invoke('crash:save-diagnostics'),
  crashQuit: () => ipcRenderer.invoke('crash:quit'),
})

let messages = {}
let currentLocale = 'en'
let barRoot = null
let latestState = null
let lastScanPayload = { jobs: [], running: 0, watching: { active: false, path: '' } }
let notifications = []
let notificationMessage = ''
let notificationAdminOnly = false
let notificationTotal = 0
let notificationOffset = 0
let notifFilter = 'all'
let notifCategory = ''
let toastHistory = []
let scanPollTimer = null
let scanLimit = 20
let scanStatus = ''
let scanTotal = 0
let runContextSeq = 0
let dismissedRunId = ''
let lastRunBarData = null
let runBarVisible = false
let offlineVisible = false
let lastUpdateState = null
let onboardingPayload = null
let onboardingShown = false
let onboardingKind = 'tour'
let onboardingStep = 0
let onboardingPreviousFocus = null

function healthLabel(health) {
  return t(`appbar.health.${health}`, {
    connected: 'Connected',
    degraded: 'Degraded',
    offline: 'Offline',
    unknown: 'Checking…',
  }[health] || health)
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function relTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return ''
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function setOfflineBanner(state) {
  if (!barRoot) return
  const bar = barRoot.querySelector('#offlinebar')
  if (!bar) return
  const connection = state?.connection?.state || 'unknown'
  const connectionIssue = connection === 'offline' || connection === 'degraded'
  const authExpired = Boolean(state?.auth?.expired)
  const visible = connectionIssue || authExpired
  if (!visible) {
    if (offlineVisible) {
      offlineVisible = false
      bar.hidden = true
      applyShellLayout()
    }
    return
  }

  const environment = state?.environment || {}
  offlineVisible = true
  bar.hidden = false
  bar.classList.toggle('degraded', connectionIssue && connection === 'degraded')
  bar.classList.toggle('auth', authExpired && !connectionIssue)

  const retry = bar.querySelector('[data-offline-action="retry"]')
  const stack = bar.querySelector('[data-offline-action="stack"]')
  const logs = bar.querySelector('[data-offline-action="logs"]')
  const signIn = bar.querySelector('[data-offline-action="signin"]')
  const showConnectionActions = !authExpired || connectionIssue
  if (retry) retry.hidden = !showConnectionActions
  if (stack) stack.hidden = !showConnectionActions
  if (logs) logs.hidden = false
  if (signIn) signIn.hidden = !authExpired

  if (authExpired && !connectionIssue) {
    bar.querySelector('#offline-title').textContent = t('auth.expired', 'Session expired')
    bar.querySelector('#offline-meta').textContent = `${t('auth.expiredDetail', 'Sign in again to continue')} · ${environment.name || environment.url || ''}`
  } else {
    bar.querySelector('#offline-title').textContent = connection === 'degraded'
      ? t('offline.degraded', 'Connection degraded')
      : t('offline.title', 'wombat-server unreachable')
    const last = relTime(environment.lastSyncAt)
    const detail = connection === 'degraded'
      ? (state.connection?.error || t('offline.degradedDetail', 'Some requests may fail.'))
      : (state.connection?.error || environment.url || '')
    bar.querySelector('#offline-meta').textContent = [last ? `${t('offline.lastSync', 'Last sync')} ${last}` : '', detail].filter(Boolean).join(' · ')
  }
  applyShellLayout()
}

function renderShellState(state) {
  if (!state) return
  latestState = state
  if (!barRoot) return

  const contextButton = barRoot.querySelector('.chip.context')
  const accountButton = barRoot.querySelector('.chip.account')
  if (!contextButton || !accountButton) return

  const environment = state.environment || {}
  const health = environment.health || 'unknown'
  const environmentName = environment.name || environment.url || t('appbar.environment', 'Environment')
  const dot = contextButton.querySelector('.healthdot')
  dot.className = `healthdot ${health}`
  contextButton.querySelector('.chip-name').textContent = environmentName
  const prod = contextButton.querySelector('.badge.prod')
  prod.hidden = environment.kind !== 'production'
  contextButton.classList.toggle('prod', environment.kind === 'production')
  const latency = environment.latencyMs != null ? `${environment.latencyMs} ms` : ''
  const lastSync = environment.lastSyncAt ? `Last sync: ${environment.lastSyncAt}` : ''
  contextButton.title = [
    environmentName,
    `${healthLabel(health)}${latency ? ` · ${latency}` : ''}`,
    environment.url,
    environment.serverVersion ? `Server ${environment.serverVersion}` : '',
    lastSync,
  ].filter(Boolean).join('\n')
  contextButton.setAttribute('aria-label', `${t('appbar.environment', 'Environment')}: ${environmentName}`)

  const auth = state.auth || {}
  const offline = state.connection?.state === 'offline'
  const signedIn = Boolean(auth.signedIn) && !offline
  const accountName = offline
    ? t('appbar.unavailable', 'Unavailable')
    : signedIn
      ? (auth.user?.displayName || auth.user?.username || t('appbar.account', 'Account'))
      : t('appbar.signIn', 'Sign in')
  accountButton.querySelector('.chip-name').textContent = accountName
  accountButton.querySelector('.avatar').textContent = signedIn
    ? initials(auth.user?.displayName || auth.user?.username || '')
    : '?'
  accountButton.classList.toggle('signed-in', signedIn)
  const method = auth.method === 'device'
    ? t('appbar.deviceSession', 'Device token')
    : t('appbar.browserSession', 'Browser session')
  accountButton.title = offline
    ? t('appbar.unavailable', 'Backend unavailable')
    : signedIn
      ? `${t('appbar.signedInAs', 'Signed in as {user}').replace('{user}', auth.user?.username || '')}\n${method}`
      : t('appbar.notSignedIn', 'Not signed in')
  accountButton.setAttribute('aria-label', `${t('appbar.account', 'Account')}: ${accountName}`)

  const runningBadge = barRoot.querySelector('#scan-running')
  const running = Number(state.scan?.running) || 0
  if (runningBadge) {
    runningBadge.hidden = running <= 0
    runningBadge.textContent = String(running)
  }
  const watchChip = barRoot.querySelector('.chip.watch')
  const watching = Boolean(state.scan?.watching?.active)
  if (watchChip) {
    watchChip.hidden = !watching
    watchChip.title = watching ? `${t('scan.watching', 'Watching')}: ${state.scan.watching.path || ''}` : ''
  }
  const notifBadge = barRoot.querySelector('#notif-count')
  const unread = Number(state.notifications?.unread) || 0
  if (notifBadge) {
    notifBadge.hidden = unread <= 0
    notifBadge.textContent = String(unread)
  }
  const bell = barRoot.querySelector('[data-action="notifications"]')
  if (bell) {
    bell.setAttribute('aria-label', `${t('notifications.title', 'Notifications')} (${unread})`)
  }
  renderWatchStatus(state)
  setOfflineBanner(state)
  if (state.update) renderUpdateChip(state.update)
}

function loadShellState() {
  ipcRenderer.invoke('shell:get-state')
    .then(renderShellState)
    .catch(() => {})
}

ipcRenderer.on('shell:state', (_event, state) => renderShellState(state))
loadShellState()

const RUN_BAR_HEIGHT = 32

const OFFLINE_BAR_HEIGHT = 34

function applyShellLayout() {
  const offset = 38 + TAB_STRIP_HEIGHT + (offlineVisible ? OFFLINE_BAR_HEIGHT : 0) + (runBarVisible ? RUN_BAR_HEIGHT : 0)
  document.documentElement.style.setProperty('--wombat-shell-offset', `${offset}px`)
  if (barRoot) {
    barRoot.host.style.setProperty('--wombat-panel-top', `${offset + 8}px`)
  }
  const baseTop = 38 + TAB_STRIP_HEIGHT
  const runbar = barRoot?.querySelector('#runbar')
  if (runbar) runbar.style.top = `${baseTop + (offlineVisible ? OFFLINE_BAR_HEIGHT : 0)}px`
  const offlinebar = barRoot?.querySelector('#offlinebar')
  if (offlinebar) offlinebar.style.top = `${baseTop}px`
}

function runTone(score) {
  if (score == null) return ''
  return score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'err'
}

function renderRunBar(run) {
  if (!run) return
  lastRunBarData = run
  const bar = el('#runbar')
  if (!bar) return
  bar.querySelector('#runbar-project').textContent = run.project || String(run.id).slice(0, 8)
  const score = bar.querySelector('#runbar-score')
  score.textContent = typeof run.score === 'number' ? `${run.score}/100` : ''
  score.className = `runbar-score ${runTone(run.score)}`
  const date = run.createdAt ? formatDateTime(run.createdAt) : ''
  bar.querySelector('#runbar-meta').textContent = [run.stage, run.branch, date].filter(Boolean).join(' · ')
  bar.title = [run.project, run.id, run.branch, run.stage].filter(Boolean).join(' · ')
  reportTabRoute()
}

async function syncRunBar() {
  if (!barRoot) return
  const runId = currentRunId()
  const bar = el('#runbar')
  if (!bar) return

  if (!runId) {
    dismissedRunId = ''
    bar.hidden = true
    runBarVisible = false
    applyShellLayout()
    return
  }
  if (dismissedRunId === runId) {
    bar.hidden = true
    runBarVisible = false
    applyShellLayout()
    return
  }

  bar.hidden = false
  runBarVisible = true
  applyShellLayout()
  bar.querySelector('#runbar-project').textContent = runId.slice(0, 8)
  bar.querySelector('#runbar-score').textContent = ''
  bar.querySelector('#runbar-meta').textContent = t('run.loading', 'Loading…')

  const seq = ++runContextSeq
  try {
    const result = await ipcRenderer.invoke('run:context', runId)
    if (seq !== runContextSeq) return
    if (result?.ok && result.run) {
      renderRunBar(result.run)
    } else {
      bar.querySelector('#runbar-project').textContent = runId.slice(0, 8)
      bar.querySelector('#runbar-meta').textContent = result?.message || t('run.unavailable', 'Run details unavailable.')
    }
  } catch (error) {
    if (seq !== runContextSeq) return
    bar.querySelector('#runbar-meta').textContent = error instanceof Error ? error.message : String(error)
  }
}

function el(selector) {
  return barRoot ? barRoot.querySelector(selector) : null
}

function basename(value) {
  const parts = String(value ?? '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function tourSteps() {
  return [
    { title: t('onboarding.tour1.title', 'Your desktop shell'), body: t('onboarding.tour1.body', 'Use the app bar to switch environments, check backend health, and reach every dashboard page.') },
    { title: t('onboarding.tour2.title', 'Search everything'), body: t('onboarding.tour2.body', 'Press ⌘⇧K (Ctrl+Shift+K). Use > for commands, @ for runs, # for controls, : for pages and ~ for environments.') },
    { title: t('onboarding.tour3.title', 'Scan without Docker'), body: t('onboarding.tour3.body', 'Scan the clipboard, choose a folder, watch a folder, or drop an IaC folder anywhere on the window.') },
    { title: t('onboarding.tour4.title', 'Runs, updates and recovery'), body: t('onboarding.tour4.body', 'The run bar links to findings and diffs. Settings keeps device tokens and updates together, and offline/crash states always offer a way back.') },
  ]
}

function renderOnboarding() {
  const overlay = el('#onboarding')
  if (!overlay) return
  const kicker = el('#onboarding-kicker')
  const title = el('#onboarding-title')
  const body = el('#onboarding-body')
  const step = el('#onboarding-step')
  const skip = el('#onboarding-skip')
  const next = el('#onboarding-next')
  if (!kicker || !title || !body || !step || !skip || !next) return

  if (onboardingKind === 'whatsnew') {
    const version = onboardingPayload?.whatsNewVersion || onboardingPayload?.version || ''
    kicker.textContent = t('onboarding.kickerWhatsNew', "What's new")
    title.textContent = t('onboarding.whatsNewTitle', "What's new in {version}").replace('{version}', version)
    body.replaceChildren()
    const list = document.createElement('ul')
    for (const item of onboardingPayload?.items ?? []) {
      const li = document.createElement('li')
      li.textContent = String(item)
      list.append(li)
    }
    body.append(list)
    step.textContent = version
    skip.hidden = true
    next.textContent = t('onboarding.done', 'Done')
    return
  }

  const steps = tourSteps()
  const current = steps[Math.min(onboardingStep, steps.length - 1)]
  kicker.textContent = t('onboarding.kicker', 'Welcome')
  title.textContent = current.title
  body.textContent = current.body
  step.textContent = `${onboardingStep + 1} / ${steps.length}`
  skip.hidden = false
  skip.textContent = t('onboarding.skip', 'Skip')
  next.textContent = onboardingStep >= steps.length - 1
    ? t('onboarding.done', 'Done')
    : t('onboarding.next', 'Next')
}

function openOnboarding(kind) {
  onboardingPreviousFocus = document.activeElement
  onboardingKind = kind
  onboardingStep = 0
  onboardingShown = true
  const overlay = el('#onboarding')
  if (!overlay) return
  renderOnboarding()
  overlay.hidden = false
  el('#onboarding-next')?.focus({ preventScroll: true })
}

async function completeOnboarding() {
  const overlay = el('#onboarding')
  onboardingShown = true
  try {
    onboardingPayload = await ipcRenderer.invoke('onboarding:complete', onboardingKind)
  } catch {
    /* best effort */
  } finally {
    if (overlay) overlay.hidden = true
    const target = onboardingPreviousFocus
    onboardingPreviousFocus = null
    if (target && typeof target.focus === 'function' && target.isConnected) {
      target.focus({ preventScroll: true })
    } else {
      barRoot?.querySelector('[data-action="palette"]')?.focus({ preventScroll: true })
    }
  }
}

function maybeShowOnboarding() {
  if (onboardingShown || !onboardingPayload) return
  if (!document.hasFocus()) return
  if (location.hash.includes('/login')) return
  if (onboardingPayload.showOnboarding) openOnboarding('tour')
  else if (onboardingPayload.showWhatsNew) openOnboarding('whatsnew')
}

function reportDashboardTheme() {
  if (!TABS_ENABLED && process.platform !== 'win32') return
  if (process.platform !== 'win32') return
  const bar = barRoot?.querySelector('.bar')
  if (!bar) return
  const match = getComputedStyle(bar).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) return
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const dark = luminance < 0.55
  if (bar.dataset.wombatReportedTheme === (dark ? 'dark' : 'light')) return
  bar.dataset.wombatReportedTheme = dark ? 'dark' : 'light'
  ipcRenderer.invoke('shell:dashboard-theme', { dark }).catch(() => {})
}

function renderTabs(payload) {
  if (!TABS_ENABLED || !barRoot) return
  const strip = barRoot.querySelector('#tabstrip')
  if (!strip) return
  strip.hidden = false
  strip.replaceChildren()
  const tabs = Array.isArray(payload?.tabs) ? payload.tabs : []
  for (const tab of tabs) {
    const item = document.createElement('div')
    item.className = 'tab-item'
    item.draggable = true
    item.dataset.tabId = tab.id
    const button = document.createElement('button')
    button.id = `wombat-tab-${tab.id}`
    button.className = `tab${tab.id === payload.activeId ? ' active' : ''}`
    button.tabIndex = tab.id === payload.activeId ? 0 : -1
    button.setAttribute('aria-pressed', tab.id === payload.activeId ? 'true' : 'false')
    button.title = tab.title || tab.route || 'Tab'
    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = tab.title || tab.route || 'Tab'
    button.append(title)
    const close = document.createElement('button')
    close.className = 'tab-close'
    close.textContent = '✕'
    close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`)
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      ipcRenderer.invoke('tabs:close', tab.id).catch(() => {})
    })
    item.append(button, close)
    button.addEventListener('click', () => ipcRenderer.invoke('tabs:activate', tab.id).catch(() => {}))
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        ipcRenderer.invoke('tabs:activate', tab.id).catch(() => {})
        return
      }
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        ipcRenderer.invoke('tabs:move', tab.id, event.key === 'ArrowLeft' ? -1 : 1).catch(() => {})
        return
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.findIndex(entry => entry.id === tab.id)
      let next = index
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
      else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = tabs.length - 1
      const target = tabs[next]
      if (!target) return
      ipcRenderer.invoke('tabs:activate', target.id).catch(() => {})
      setTimeout(() => el(`#wombat-tab-${target.id}`)?.focus({ preventScroll: true }), 80)
    })
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) ipcRenderer.invoke('tabs:close', tab.id).catch(() => {})
    })
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      ipcRenderer.invoke('tabs:context-menu', tab.id).catch(() => {})
    })
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/wombat-tab', tab.id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      item.classList.add('dragging')
    })
    item.addEventListener('dragend', () => item.classList.remove('dragging'))
    item.addEventListener('dragover', (event) => {
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    })
    item.addEventListener('drop', (event) => {
      event.preventDefault()
      const draggedId = event.dataTransfer?.getData('text/wombat-tab')
      if (!draggedId || draggedId === tab.id) return
      const targetIndex = tabs.findIndex(entry => entry.id === tab.id)
      ipcRenderer.invoke('tabs:reorder', draggedId, targetIndex).catch(() => {})
    })
    strip.append(item)
  }
  const add = document.createElement('button')
  add.className = 'tab-add'
  add.textContent = '+'
  add.title = t('tabs.new', 'New tab')
  add.setAttribute('aria-label', t('tabs.new', 'New tab'))
  add.addEventListener('click', () => ipcRenderer.invoke('tabs:new', { route: 'dashboard' }).catch(() => {}))
  const addWrap = document.createElement('div')
  addWrap.append(add)
  strip.append(addWrap)
  requestAnimationFrame(() => {
    strip.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
}

function reportTabRoute() {
  if (!TABS_ENABLED) return
  const route = String(location.hash || '').replace(/^#\/?/, '').split(/[?/]/)[0] || 'dashboard'
  const runId = currentRunId()
  const title = lastRunBarData?.project
    || (runId ? t('tabs.run', 'Run') : route.charAt(0).toUpperCase() + route.slice(1))
  ipcRenderer.invoke('tabs:route', { route, runId, title }).catch(() => {})
}

function renderUpdateChip(state) {
  if (!state) return
  lastUpdateState = { ...(lastUpdateState ?? {}), ...state }
  if (!barRoot) return
  const chip = barRoot.querySelector('.chip.update')
  if (!chip) return
  const status = lastUpdateState.state || 'idle'
  const visible = ['available', 'downloading', 'ready'].includes(status)
  chip.hidden = !visible
  if (!visible) return
  let label = t('updates.available', 'Update')
  if (status === 'downloading') {
    const progress = Number(lastUpdateState.progress) || 0
    label = progress > 0
      ? `${t('updates.downloading', 'Updating')} ${progress}%`
      : t('updates.downloading', 'Updating…')
  } else if (status === 'ready') {
    label = t('updates.install', 'Install update')
  }
  chip.querySelector('.chip-name').textContent = label
  chip.setAttribute('aria-label', lastUpdateState.latest ? `${label}: ${lastUpdateState.latest}` : label)
  chip.title = lastUpdateState.latest
    ? `${label}: ${lastUpdateState.latest}`
    : label
}

function renderWatchStatus(state = latestState) {
  const node = el('#scan-watch-status')
  if (!node) return
  const watching = Boolean(state?.scan?.watching?.active)
  node.hidden = !watching
  node.textContent = watching
    ? `${t('scan.watching', 'Watching')}: ${state.scan.watching.path || ''}`
    : ''
}

function scanStatusLabel(status) {
  return t(`scan.status.${status}`, status || 'queued')
}

function renderScanJobs(payload = {}) {
  lastScanPayload = payload
  if (!barRoot) return
  const list = el('#scan-job-list')
  const empty = el('#scan-empty')
  if (!list || !empty) return
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
  scanTotal = Number(payload.total) || scanTotal || jobs.length
  const updated = el('#scan-updated')
  if (updated) updated.textContent = `${t('scan.updated', 'Updated')} ${new Date().toLocaleTimeString()}`
  const more = el('#scan-more')
  if (more) more.hidden = jobs.length >= scanTotal
  list.replaceChildren()
  empty.hidden = jobs.length > 0
  if (!jobs.length) {
    empty.textContent = payload.message || t('scan.empty', 'No recent scans.')
  }

  let queuePosition = 0
  for (const job of jobs) {
    if (job.status === 'queued') queuePosition += 1
    const row = document.createElement('div')
    row.className = 'job'
    row.setAttribute('role', 'listitem')

    const head = document.createElement('div')
    head.className = 'job-head'
    const dot = document.createElement('span')
    dot.className = `status-dot ${job.status || 'queued'}`
    const title = document.createElement('span')
    title.className = 'job-title'
    title.textContent = job.project || basename(job.path) || String(job.id).slice(0, 8)
    head.append(dot, title)

    const meta = document.createElement('div')
    meta.className = 'job-meta'
    const queue = job.status === 'queued' ? `${t('scan.queuePosition', 'Queue')} #${queuePosition}` : ''
    meta.textContent = [scanStatusLabel(job.status), queue, job.stage, job.created_at ? formatDateTime(job.created_at) : '']
      .filter(Boolean).join(' · ')

    row.append(head, meta)

    if (job.status === 'queued' || job.status === 'running' || job.status === 'succeeded') {
      const progress = document.createElement('div')
      progress.className = 'progress'
      const bar = document.createElement('span')
      bar.style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`
      progress.append(bar)
      row.append(progress)
    }

    if (job.error) {
      const error = document.createElement('div')
      error.className = 'job-error'
      error.textContent = job.error
      row.append(error)
    }

    const actions = document.createElement('div')
    actions.className = 'job-actions'
    if (job.status === 'queued' || job.status === 'running') {
      const cancel = document.createElement('button')
      cancel.textContent = t('scan.cancel', 'Cancel')
      cancel.addEventListener('click', async () => {
        await ipcRenderer.invoke('scan:cancel', job.id).catch(() => {})
        loadScanJobs()
      })
      actions.append(cancel)
    }
    if (job.run_id) {
      const open = document.createElement('button')
      open.textContent = t('scan.openRun', 'Open run')
      open.addEventListener('click', () => ipcRenderer.invoke('scan:open-run', job.run_id).catch(() => {}))
      actions.append(open)
    }
    if (job.status === 'failed' && job.triggered_by !== 'upload') {
      const retry = document.createElement('button')
      retry.textContent = t('scan.retry', 'Retry')
      retry.addEventListener('click', async () => {
        const result = await ipcRenderer.invoke('scan:retry', job.id).catch(() => ({ ok: false }))
        if (!result?.ok) {
          const empty = el('#scan-empty')
          if (empty) {
            empty.hidden = false
            empty.textContent = `${t('scan.retryFailed', 'Retry failed')}: ${result?.message || ''}`
          }
        }
        loadScanJobs()
      })
      actions.append(retry)
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      const again = document.createElement('button')
      again.textContent = t('scan.scanAgain', 'Scan again')
      again.addEventListener('click', () => ipcRenderer.invoke('scan:choose').catch(() => {}))
      actions.append(again)
    }
    if (actions.children.length) row.append(actions)
    list.append(row)
  }
  renderWatchStatus(latestState)
}

async function loadScanJobs() {
  try {
    const payload = await ipcRenderer.invoke('scan:jobs', { limit: scanLimit, status: scanStatus })
    renderScanJobs(payload || {})
  } catch (error) {
    renderScanJobs({ jobs: [], message: error instanceof Error ? error.message : String(error) })
  }
}

function renderNotifications() {
  if (!barRoot) return
  const list = el('#notif-list')
  const status = el('#notif-status')
  const more = el('#notif-more')
  const category = el('#notif-category')
  if (!list || !status) return
  list.replaceChildren()
  if (category && category.value !== notifCategory) category.value = notifCategory
  const updated = el('#notif-updated')
  if (updated) updated.textContent = `${t('notifications.updated', 'Updated')} ${new Date().toLocaleTimeString()}`

  if (notificationMessage) {
    status.hidden = false
    status.textContent = notificationMessage
    if (more) more.hidden = true
    return
  }

  const filtered = notifFilter === 'unread'
    ? notifications.filter(item => !item.is_read)
    : notifications
  status.hidden = filtered.length > 0
  if (!filtered.length) {
    status.textContent = notifications.length
      ? t('notifications.noUnread', 'No unread notifications.')
      : t('notifications.empty', 'No notifications.')
  }

  for (const item of filtered) {
    const row = document.createElement('div')
    row.className = `notif${item.is_read ? '' : ' unread'}`
    row.setAttribute('role', 'listitem')
    row.tabIndex = 0

    const title = document.createElement('div')
    title.className = 'notif-title'
    title.textContent = item.title || t('notifications.untitled', 'Notification')

    const message = document.createElement('div')
    message.className = 'notif-message'
    message.textContent = item.message || ''

    const meta = document.createElement('div')
    meta.className = 'notif-meta'
    meta.textContent = [item.category, item.project, item.created_at ? formatDateTime(item.created_at) : '']
      .filter(Boolean).join(' · ')

    row.append(title, message, meta)
    row.addEventListener('click', () => openNotification(item))
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openNotification(item)
      }
    })
    list.append(row)
  }

  if (more) more.hidden = notifications.length >= notificationTotal

  if (toastHistory.length) {
    const header = document.createElement('div')
    header.className = 'section'
    header.setAttribute('role', 'presentation')
    header.textContent = t('notifications.recentActivity', 'Recent activity')
    list.append(header)
    for (const toast of toastHistory.slice(0, 8)) {
      const row = document.createElement('div')
      row.className = 'notif'
      const title = document.createElement('div')
      title.className = 'notif-title'
      title.textContent = toast.title || toast.level
      const body = document.createElement('div')
      body.className = 'notif-message'
      body.textContent = toast.body || ''
      const meta = document.createElement('div')
      meta.className = 'notif-meta'
      meta.textContent = [toast.level, formatDateTime(toast.at)].filter(Boolean).join(' · ')
      row.append(title, body, meta)
      list.append(row)
    }
  }
}

async function loadNotifications({ append = false } = {}) {
  try {
    const offset = append ? notificationOffset : 0
    const payload = await ipcRenderer.invoke('notifications:list', {
      limit: 20,
      offset,
      unreadOnly: notifFilter === 'unread',
      category: notifCategory || null,
    })
    notificationAdminOnly = Boolean(payload.adminOnly)
    notificationMessage = payload.ok ? '' : (payload.message || t('notifications.unavailable', 'Notifications unavailable.'))
    if (payload.ok && Array.isArray(payload.items)) {
      notifications = append ? [...notifications, ...payload.items] : payload.items
      notificationTotal = Number(payload.total) || notifications.length
      notificationOffset = notifications.length
    } else {
      notifications = []
      notificationTotal = 0
      notificationOffset = 0
    }
    renderNotifications()
  } catch (error) {
    notificationMessage = error instanceof Error ? error.message : String(error)
    notifications = []
    notificationTotal = 0
    notificationOffset = 0
    renderNotifications()
  }
}

async function openNotification(item) {
  if (!item.is_read) {
    await ipcRenderer.invoke('notifications:mark-read', item.id).catch(() => {})
    await loadNotifications()
  }
  await ipcRenderer.invoke('notifications:open', {
    route: item.link_route || 'notifications',
    runId: item.link_run_id || null,
    url: item.link_url || '',
  }).catch(() => {})
  closePanels()
}

function stopScanPolling() {
  if (scanPollTimer) clearInterval(scanPollTimer)
  scanPollTimer = null
}

function startScanPolling() {
  stopScanPolling()
  scanPollTimer = setInterval(loadScanJobs, 5_000)
}

function closePanels() {
  const scanPanel = el('#scan-panel')
  const notifPanel = el('#notification-panel')
  if (scanPanel) scanPanel.hidden = true
  if (notifPanel) notifPanel.hidden = true
  stopScanPolling()
  el('[data-action="scan-center"]')?.setAttribute('aria-expanded', 'false')
  el('[data-action="notifications"]')?.setAttribute('aria-expanded', 'false')
}

function togglePanel(name) {
  if (!barRoot) return
  const scanPanel = el('#scan-panel')
  const notifPanel = el('#notification-panel')
  const target = name === 'scan' ? scanPanel : notifPanel
  if (!target) return
  const open = target.hidden
  scanPanel.hidden = true
  notifPanel.hidden = true
  stopScanPolling()
  if (!open) {
    closePanels()
    return
  }
  target.hidden = false
  el(name === 'scan' ? '[data-action="scan-center"]' : '[data-action="notifications"]')
    ?.setAttribute('aria-expanded', 'true')
  target.querySelector('.panel-close')?.focus({ preventScroll: true })
  if (name === 'scan') {
    renderScanJobs(lastScanPayload)
    loadScanJobs()
    startScanPolling()
  } else {
    loadNotifications()
  }
}

function removeToast(node) {
  if (!node || !node.isConnected) return
  node.remove()
}

function showToast(toast) {
  const container = el('#toast-container')
  if (!container || !toast) return
  toastHistory = [{ level: toast.level, title: toast.title, body: toast.body, at: new Date().toISOString() }, ...toastHistory].slice(0, 20)
  if (!el('#notification-panel')?.hidden) renderNotifications()
  while (container.children.length >= 3) container.firstElementChild.remove()

  const node = document.createElement('div')
  node.className = `toast ${toast.level || 'info'}`

  const head = document.createElement('div')
  head.className = 'toast-head'
  const title = document.createElement('div')
  title.className = 'toast-title'
  title.textContent = toast.title || ''
  const close = document.createElement('button')
  close.className = 'toast-close'
  close.textContent = '✕'
  close.setAttribute('aria-label', t('shell.close', 'Close'))
  close.addEventListener('click', () => removeToast(node))
  head.append(title, close)
  node.append(head)

  if (toast.body) {
    const body = document.createElement('div')
    body.className = 'toast-body'
    body.textContent = toast.body
    node.append(body)
  }

  let timer = null
  const dismiss = () => {
    if (timer) clearTimeout(timer)
    timer = null
    removeToast(node)
  }
  const schedule = (ms) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(dismiss, ms)
  }

  if (toast.action) {
    const action = document.createElement('button')
    action.className = 'toast-action'
    action.textContent = toast.actionLabel || t('toast.open', 'Open')
    action.addEventListener('click', async () => {
      await ipcRenderer.invoke('toast:action', toast.action).catch(() => {})
      dismiss()
    })
    node.append(action)
  }

  node.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer)
    timer = null
  })
  node.addEventListener('mouseleave', () => schedule(2_500))
  container.append(node)
  schedule(Number(toast.ttl) || 6_000)
}

function setupDropTarget() {
  let depth = 0
  const hasFiles = (event) => {
    const types = event?.dataTransfer?.types
    return types ? Array.from(types).includes('Files') : false
  }

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth += 1
    const overlay = el('#drop-overlay')
    if (overlay) overlay.hidden = false
  }, true)

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    const overlay = el('#drop-overlay')
    if (overlay) overlay.hidden = false
  }, true)

  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const overlay = el('#drop-overlay')
      if (overlay) overlay.hidden = true
    }
  }, true)

  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth = 0
    const overlay = el('#drop-overlay')
    if (overlay) overlay.hidden = true
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      path = ''
    }
    if (path) ipcRenderer.invoke('scan:drop', path).catch(() => {})
  }, true)
}

function setupAppBarPanels() {
  el('#onboarding-skip')?.addEventListener('click', () => completeOnboarding())
  el('#onboarding-next')?.addEventListener('click', () => {
    const total = tourSteps().length
    if (onboardingKind === 'tour' && onboardingStep < total - 1) {
      onboardingStep += 1
      renderOnboarding()
      return
    }
    completeOnboarding()
  })
  el('#onboarding')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      completeOnboarding()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...barRoot.querySelectorAll('#onboarding button:not([hidden])')]
    if (focusable.length === 0) return
    const index = focusable.indexOf(document.activeElement)
    const next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
    event.preventDefault()
    focusable[next].focus()
  })

  barRoot.querySelectorAll('[data-offline-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.offlineAction
      if (action === 'retry') ipcRenderer.invoke('shell:action', 'refresh').catch(() => {})
      else if (action === 'stack') ipcRenderer.invoke('appbar:action', 'start-stack').catch(() => {})
      else if (action === 'logs') ipcRenderer.invoke('appbar:action', 'logs').catch(() => {})
      else if (action === 'signin') ipcRenderer.invoke('auth:recover').catch(() => {})
    })
  })

  barRoot.querySelectorAll('[data-run-action]').forEach(button => {
    button.addEventListener('click', async () => {
      const runId = currentRunId()
      if (!runId) return
      const action = button.dataset.runAction
      if (action === 'close') {
        dismissedRunId = runId
        const bar = el('#runbar')
        if (bar) bar.hidden = true
        runBarVisible = false
        applyShellLayout()
        return
      }
      await ipcRenderer.invoke('run:action', { action, runId }).catch(() => {})
    })
  })

  barRoot.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => closePanels())
  })
  barRoot.querySelectorAll('[data-scan-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.scanAction
      if (action === 'clipboard') ipcRenderer.invoke('appbar:action', 'scan-clipboard').catch(() => {})
      else if (action === 'folder') ipcRenderer.invoke('scan:choose').catch(() => {})
      else if (action === 'watch') ipcRenderer.invoke('scan:choose-watch').catch(() => {})
      else if (action === 'stop-watch') ipcRenderer.invoke('scan:stop-watch').then(loadScanJobs).catch(() => {})
      else if (action === 'cancel-all') ipcRenderer.invoke('scan:cancel-all').then(loadScanJobs).catch(() => {})
      else if (action === 'refresh') loadScanJobs()
    })
  })
  barRoot.querySelectorAll('[data-notif-filter]').forEach(button => {
    button.addEventListener('click', () => {
      notifFilter = button.dataset.notifFilter
      barRoot.querySelectorAll('[data-notif-filter]').forEach(other => {
        other.classList.toggle('active', other === button)
      })
      notifications = []
      notificationOffset = 0
      loadNotifications()
    })
  })
  el('#scan-filter')?.addEventListener('change', (event) => {
    scanStatus = String(event.target.value || '')
    scanLimit = 20
    loadScanJobs()
  })
  el('#scan-more')?.addEventListener('click', () => {
    scanLimit = Math.min(100, scanLimit + 20)
    loadScanJobs()
  })

  el('#notif-category')?.addEventListener('change', (event) => {
    notifCategory = String(event.target.value || '')
    notifications = []
    notificationOffset = 0
    loadNotifications()
  })
  el('#notif-more')?.addEventListener('click', () => loadNotifications({ append: true }))

  el('#notif-mark-all')?.addEventListener('click', async () => {
    await ipcRenderer.invoke('notifications:mark-all').catch(() => {})
    await loadNotifications()
  })

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanels()
    if (event.key === '?' && !event.metaKey && !event.ctrlKey) {
      const tag = String(event.target?.tagName || '').toLowerCase()
      if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return
      event.preventDefault()
      ipcRenderer.invoke('appbar:action', 'help-shortcuts').catch(() => {})
    }
  })
  window.addEventListener('focus', () => maybeShowOnboarding())
  window.addEventListener('pointerdown', (event) => {
    if (!barRoot?.host.contains(event.target)) closePanels()
  })
  setupDropTarget()
}

ipcRenderer.on('scan:jobs', (_event, payload) => renderScanJobs(payload || {}))
ipcRenderer.on('shell:toast', (_event, toast) => showToast(toast))
ipcRenderer.on('updates:state', (_event, state) => renderUpdateChip(state))
ipcRenderer.on('shell:tabs', (_event, payload) => renderTabs(payload))
ipcRenderer.on('shell:onboarding-done', (_event, payload) => {
  onboardingPayload = payload ?? { ...(onboardingPayload || {}), showOnboarding: false, showWhatsNew: false }
  onboardingShown = true
  const overlay = el('#onboarding')
  if (overlay) overlay.hidden = true
})

ipcRenderer.on('shell:onboarding', (_event, payload) => {
  if (!payload) return
  onboardingPayload = payload
  onboardingShown = false
  openOnboarding(payload.showOnboarding ? 'tour' : 'whatsnew')
})
ipcRenderer.invoke('updates:get').then(renderUpdateChip).catch(() => {})

function t(key, fallback) {
  return messages[key] ?? fallback
}

function formatDateTime(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(currentLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function applyAppBarI18n() {
  if (!barRoot) return
  for (const node of barRoot.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, node.textContent)
  }
  const bar = barRoot.querySelector('.bar')
  if (bar) bar.setAttribute('aria-label', t('appbar.label', 'WOMBATpass navigation'))
  renderShellState(latestState)
  renderScanJobs(lastScanPayload)
  renderNotifications()
  if (lastRunBarData) renderRunBar(lastRunBarData)
  renderUpdateChip(lastUpdateState)
}

function loadMessages() {
  ipcRenderer.invoke('shell:get-i18n')
    .then((payload) => {
      if (payload && payload.messages) {
        messages = payload.messages
        currentLocale = payload.locale || 'en'
        applyAppBarI18n()
      }
    })
    .catch(() => {})
}

ipcRenderer.on('shell:i18n', (_event, payload) => {
  if (payload && payload.messages) {
    messages = payload.messages
    currentLocale = payload.locale || 'en'
    applyAppBarI18n()
  }
})

loadMessages()

const BAR_HEIGHT = 38
const MOD = process.platform === 'darwin' ? '⌘' : 'Ctrl'
const NAV_ITEMS = [
  ['dashboard', 'Dashboard', 'nav.dashboard'],
  ['findings', 'Findings', 'nav.findings'],
  ['catalogue', 'Catalogue', 'nav.catalogue'],
  ['runs', 'Runs', 'nav.runs'],
  ['evidence', 'Evidence', 'nav.evidence'],
  ['waivers', 'Waivers', 'nav.waivers'],
  ['compliance', 'Compliance', 'nav.compliance'],
]

function currentRunId() {
  const match = String(location.hash || '').match(/[?&]run=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * The dashboard's hash router can be restored at "#/?run=…", which renders an
 * empty shell because the index route is bypassed by the query. Normalize it to
 * the dashboard route.
 */
function normalizeRoute() {
  const raw = String(location.hash || '')
  if (raw === '' || raw === '#' || /^#\/?(\?|$)/.test(raw)) {
    const runId = currentRunId()
    location.replace(`#/dashboard${runId ? `?run=${encodeURIComponent(runId)}` : ''}`)
    return true
  }
  return false
}

function navigate(route) {
  const runId = currentRunId()
  location.hash = `#/${route}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`
}

function injectAppBar() {
  if (document.getElementById('wombat-appbar-host')) return

  // Page-level layout: reserve the bar height and shift the dashboard's fixed
  // top navigation down by the same amount.
  const pageStyle = document.createElement('style')
  pageStyle.id = 'wombat-appbar-page-style'
  pageStyle.textContent = `
    body {
      padding-top: var(--wombat-shell-offset, ${BAR_HEIGHT}px) !important;
      box-sizing: border-box !important;
    }
    #root { height: 100% !important; }
    #root > div { min-height: calc(100vh - var(--wombat-shell-offset, ${BAR_HEIGHT}px)) !important; }
    .layout { height: 100% !important; }
    .app-top-nav { top: calc(var(--impersonation-banner-height, 0px) + var(--wombat-shell-offset, ${BAR_HEIGHT}px)) !important; }
    .impersonation-banner { top: var(--wombat-shell-offset, ${BAR_HEIGHT}px) !important; }
  `
  document.head.appendChild(pageStyle)

  const host = document.createElement('div')
  host.id = 'wombat-appbar-host'
  host.style.cssText = `position:fixed;top:0;left:0;right:0;height:${BAR_HEIGHT}px;z-index:1500;`
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const navButtons = NAV_ITEMS.map(([route, label, key]) =>
    `<button class="link" data-route="${route}" data-i18n="${key}">${label}</button>`,
  ).join('')
  const platformClass = process.platform === 'darwin'
    ? 'platform-darwin'
    : process.platform === 'win32' ? 'platform-win32' : 'platform-linux'
  const nativeClass = NATIVE_CHROME ? 'native-chrome' : 'default-chrome' 

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        height: ${BAR_HEIGHT}px; display: flex; align-items: center; gap: 2px;
        padding: 0 10px; box-sizing: border-box;
        background: var(--nav-bg, var(--surface, #141a22));
        border-bottom: 1px solid var(--border, #26313d);
        color: var(--text, #e6edf5);
        font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased; user-select: none;
        backdrop-filter: blur(12px) saturate(120%);
      }
      .bar.native-chrome { -webkit-app-region: drag; }
      .bar.native-chrome .link,
      .bar.native-chrome .action,
      .bar.native-chrome .brand,
      .bar.native-chrome .link *,
      .bar.native-chrome .action * {
        -webkit-app-region: no-drag;
      }
      .bar.platform-darwin.native-chrome { padding-left: 84px; }
      .bar.platform-win32.native-chrome { padding-right: 150px; }
      .brand {
        display: flex; align-items: center; gap: 6px; padding: 0 10px 0 2px;
        font-size: 12px; font-weight: 800; white-space: nowrap;
      }
      .brand span { color: var(--waf-brand, #4f8cff); }
      .link, .action {
        height: 26px; display: inline-flex; align-items: center; gap: 5px;
        padding: 0 9px; border-radius: 7px; border: 1px solid transparent;
        background: transparent; color: var(--muted, #93a3b5);
        font: inherit; font-weight: 600; white-space: nowrap; cursor: pointer;
      }
      .link:hover, .action:hover {
        background: var(--nav-item-hover, var(--nav-surf, rgba(127,127,127,.12)));
        color: var(--text, #e6edf5);
        border-color: var(--border, #26313d);
      }
      .link.active {
        color: var(--text, #e6edf5);
        background: color-mix(in srgb, var(--waf-brand, #4f8cff) 16%, transparent);
        border-color: color-mix(in srgb, var(--waf-brand, #4f8cff) 30%, transparent);
      }
      .spacer { flex: 1; }
      .chip {
        height: 26px; display: inline-flex; align-items: center; gap: 6px;
        max-width: 180px; padding: 0 8px; border-radius: 7px;
        border: 1px solid transparent; background: transparent;
        color: var(--muted, #93a3b5); font: inherit; font-weight: 600;
        white-space: nowrap; cursor: pointer;
      }
      .chip:hover {
        background: var(--nav-item-hover, var(--nav-surf, rgba(127,127,127,.12)));
        color: var(--text, #e6edf5); border-color: var(--border, #26313d);
      }
      .chip .chip-name { overflow: hidden; text-overflow: ellipsis; max-width: 112px; }
      .healthdot {
        width: 7px; height: 7px; border-radius: 50%; flex: none;
        background: var(--muted, #93a3b5);
      }
      .healthdot.connected { background: var(--ok, #3fb950); box-shadow: 0 0 6px rgba(63,185,80,.5); }
      .healthdot.degraded { background: var(--warn, #d29922); }
      .healthdot.offline { background: var(--err, #f85149); box-shadow: 0 0 6px rgba(248,81,73,.45); }
      .badge.prod {
        font-size: 8px; font-weight: 800; letter-spacing: .06em;
        color: #fff; background: #c2410c; border-radius: 4px; padding: 1px 4px;
      }
      .chip.prod { border-color: rgba(248,81,73,.45); }
      .chip .avatar {
        width: 18px; height: 18px; border-radius: 50%;
        display: grid; place-items: center; flex: none;
        font-size: 9px; font-weight: 800; color: var(--text, #e6edf5);
        background: color-mix(in srgb, var(--waf-brand, #4f8cff) 24%, transparent);
        border: 1px solid color-mix(in srgb, var(--waf-brand, #4f8cff) 40%, transparent);
      }
      .chip.signed-in .avatar { color: var(--text, #e6edf5); }
      @media (max-width: 1240px) {
        .chip.account .chip-name { display: none; }
        .chip.account { padding: 0 7px; }
      }
      @media (max-width: 1080px) {
        .chip.context .chip-name { display: none; }
        .chip.context { padding: 0 7px; }
      }
      .kbd {
        font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted, #93a3b5);
        border: 1px solid var(--border, #26313d); border-radius: 4px; padding: 1px 4px;
      }
      .help { border-color: var(--border, #26313d); }
      .help:hover { border-color: var(--waf-brand, #4f8cff); }
      [hidden] { display: none !important; }
      .tabstrip {
        position: fixed; top: 38px; left: 0; right: 0; height: 28px;
        display: flex; align-items: flex-end; gap: 2px; padding: 0 8px;
        background: var(--surface, #141a22); border-bottom: 1px solid var(--border, #26313d);
        z-index: 1497; box-sizing: border-box; overflow-x: auto;
      }
      .tabstrip[hidden] { display: none !important; }
      .tabstrip .tab-item { display: inline-flex; align-items: flex-end; flex: none; }
      .tabstrip .tab {
        height: 25px; display: inline-flex; align-items: center; gap: 6px;
        max-width: 200px; padding: 0 8px; border: 1px solid transparent; border-bottom: 0;
        border-radius: 6px 6px 0 0; background: transparent; color: var(--muted, #93a3b5);
        font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-weight: 600; white-space: nowrap; cursor: pointer; flex: none;
      }
      .tabstrip .tab.active {
        background: var(--bg, #0b0f14); color: var(--text, #e6edf5);
        border-color: var(--border, #26313d);
      }
      .tabstrip .tab-title { overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
      .tabstrip .tab-close {
        height: 25px; border: 0; background: none; color: var(--muted, #93a3b5); opacity: .65;
        padding: 0 1px; cursor: pointer; font-size: 11px; line-height: 1;
      }
      .tabstrip .tab-close:hover { opacity: 1; }
      .tabstrip .tab-item.dragging { opacity: .45; }
      .tabstrip .tab-add {
        height: 25px; width: 24px; border: 0; background: transparent;
        color: var(--muted, #93a3b5); font-size: 15px; cursor: pointer; flex: none;
      }
      .tabstrip .tab-add:hover { color: var(--text, #e6edf5); }
      /* Floating app chrome is intentionally dark in both dashboard themes;
         the dashboard's --surface-2 is not guaranteed to be a light card. */
      .runbar {
        position: fixed; top: 38px; left: 0; right: 0; height: 32px;
        display: flex; align-items: center; gap: 8px; padding: 0 12px;
        background: var(--surface, #141a22); border-bottom: 1px solid var(--border, #26313d);
        color: var(--text, #e6edf5); z-index: 1499; -webkit-app-region: no-drag;
        font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-sizing: border-box;
      }
      .runbar[hidden] { display: none !important; }
      .runbar-badge {
        font-size: 8px; font-weight: 800; letter-spacing: .08em;
        padding: 2px 5px; border-radius: 4px;
        color: var(--accent, #4f8cff); border: 1px solid color-mix(in srgb, var(--accent, #4f8cff) 45%, transparent);
      }
      .runbar-project { font-weight: 700; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .runbar-score { font-weight: 800; }
      .runbar-score.ok { color: var(--ok, #3fb950); }
      .runbar-score.warn { color: var(--warn, #d29922); }
      .runbar-score.err { color: var(--err, #f85149); }
      .runbar-meta { color: var(--muted, #93a3b5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .runbar-spacer { flex: 1; }
      .runbar button {
        height: 22px; padding: 0 7px; border-radius: 5px;
        border: 1px solid var(--border, #26313d); background: transparent;
        color: var(--muted, #93a3b5); font: inherit; font-weight: 600; cursor: pointer;
      }
      .runbar button:hover { color: var(--text, #e6edf5); background: var(--nav-item-hover, rgba(127,127,127,.12)); }
      .runbar button.runbar-close { border-color: transparent; padding: 0 4px; }
      .offlinebar {
        position: fixed; top: 38px; left: 0; right: 0; height: 34px;
        display: flex; align-items: center; gap: 8px; padding: 0 12px;
        background: color-mix(in srgb, var(--err, #f85149) 14%, var(--surface, #141a22));
        border-bottom: 1px solid color-mix(in srgb, var(--err, #f85149) 45%, transparent);
        color: var(--text, #e6edf5); z-index: 1498;
        font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-sizing: border-box;
      }
      .offlinebar[hidden] { display: none !important; }
      .offlinebar.degraded { background: color-mix(in srgb, var(--warn, #d29922) 16%, var(--surface, #141a22)); border-bottom-color: color-mix(in srgb, var(--warn, #d29922) 50%, transparent); }
      .offlinebar.auth { background: color-mix(in srgb, var(--accent, #4f8cff) 14%, var(--surface, #141a22)); border-bottom-color: color-mix(in srgb, var(--accent, #4f8cff) 45%, transparent); }
      .offlinebar.auth .status-dot { background: var(--accent, #4f8cff); }
      .offlinebar .status-dot.offline { background: var(--err, #f85149); }
      .offlinebar.degraded .status-dot { background: var(--warn, #d29922); }
      .offlinebar button {
        height: 22px; padding: 0 7px; border-radius: 5px;
        border: 1px solid color-mix(in srgb, var(--err, #f85149) 40%, var(--border, #26313d));
        background: transparent; color: var(--text, #e6edf5);
        font: inherit; font-weight: 600; cursor: pointer;
      }
      .offlinebar button:hover { background: rgba(127,127,127,.14); }
      .offline-meta { color: var(--muted, #93a3b5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel, .toasts, .toast, .drop-card {
        --bg: #0b0f14;
        --surface: #141a22;
        --surface-2: #1b232d;
        --border: #2a3442;
        --text: #e6edf5;
        --muted: #93a3b5;
        --accent: #4f8cff;
        --ok: #3fb950;
        --warn: #d29922;
        --err: #f85149;
      }
      .split { display: inline-flex; align-items: center; }
      .split .scan-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
      .split .scan-more { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 5px; margin-left: -1px; }
      .badge-count {
        min-width: 15px; height: 15px; padding: 0 4px; margin-left: 4px;
        border-radius: 8px; background: #c2410c; color: #fff;
        font: 700 9px/15px -apple-system, sans-serif; text-align: center;
      }
      .bell { position: relative; }
      .chip.watch { color: var(--warn, #d29922); border-color: color-mix(in srgb, var(--warn, #d29922) 45%, transparent); }
      .chip.update { color: var(--accent, #4f8cff); border-color: color-mix(in srgb, var(--accent, #4f8cff) 45%, transparent); }
      .panel {
        position: fixed; top: var(--wombat-panel-top, 46px); right: 10px; width: 400px;
        max-height: calc(100vh - 58px); display: flex; flex-direction: column;
        z-index: 1600; background: var(--surface, #141a22);
        border: 1px solid var(--border, #26313d); border-radius: 12px;
        box-shadow: 0 18px 50px rgba(0,0,0,.45); color: var(--text, #e6edf5);
        overflow: hidden;
      }
      .panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #26313d); }
      .panel-title { flex: 1; font-size: 12px; font-weight: 700; letter-spacing: .02em; }
      .panel-updated { color: var(--muted, #93a3b5); font-size: 9px; white-space: nowrap; }
      .panel-close { border: 0; background: none; color: var(--muted, #93a3b5); font-size: 14px; cursor: pointer; padding: 0 2px; }
      .panel-close:hover { color: var(--text, #e6edf5); }
      .panel-body { overflow-y: auto; padding: 8px 10px 12px; }
      .panel-tabs { display: flex; gap: 6px; padding: 8px 10px 0; flex-wrap: wrap; }
      .panel-tabs button, .scan-actions button, .job-actions button, .toast-action {
        border: 1px solid var(--border, #26313d); background: var(--surface-2, #1a222c);
        color: var(--text, #e6edf5); border-radius: 6px; padding: 4px 8px;
        font: inherit; font-size: 10px; cursor: pointer;
      }
      .panel-tabs button.active { border-color: var(--accent, #4f8cff); color: var(--accent, #4f8cff); }
      .panel-tabs select { flex: 1; min-width: 100px; height: 24px; border-radius: 6px; border: 1px solid var(--border, #26313d); background: var(--surface-2, #1b232d); color: var(--text, #e6edf5); font: inherit; font-size: 10px; }
      .scan-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px 8px; }
      .panel-empty { padding: 22px 12px; text-align: center; color: var(--muted, #93a3b5); font-size: 11px; white-space: pre-wrap; }
      .job { border: 1px solid var(--border, #26313d); border-radius: 8px; padding: 8px; margin: 6px 0; background: var(--surface-2, #1a222c); }
      .job-head { display: flex; gap: 6px; align-items: center; }
      .job-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
      .job-meta { color: var(--muted, #93a3b5); font-size: 10px; margin-top: 2px; }
      .job-error { color: var(--err, #f85149); font-size: 10px; margin-top: 4px; word-break: break-word; }
      .progress { height: 4px; background: var(--border, #26313d); border-radius: 2px; margin-top: 6px; overflow: hidden; }
      .progress > span { display: block; height: 100%; background: var(--accent, #4f8cff); transition: width .2s ease; }
      .job-actions { display: flex; gap: 6px; margin-top: 6px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted, #93a3b5); flex: none; }
      .status-dot.running, .status-dot.queued { background: var(--accent, #4f8cff); }
      .status-dot.succeeded { background: var(--ok, #3fb950); }
      .status-dot.failed { background: var(--err, #f85149); }
      .status-dot.cancelled { background: var(--muted, #93a3b5); }
      .notif { border-bottom: 1px solid var(--border, #26313d); padding: 8px 4px; cursor: pointer; }
      .notif:last-child { border-bottom: 0; }
      .notif.unread .notif-title { font-weight: 700; }
      .notif-title { font-size: 12px; }
      .notif-message { color: var(--muted, #93a3b5); font-size: 11px; margin-top: 2px; }
      .notif-meta { color: var(--muted, #93a3b5); font-size: 9px; margin-top: 3px; text-transform: uppercase; letter-spacing: .06em; }
      .toasts { position: fixed; right: 14px; bottom: 14px; width: 330px; display: flex; flex-direction: column; gap: 8px; z-index: 1700; pointer-events: none; }
      .toast {
        pointer-events: auto; background: var(--surface, #141a22);
        border: 1px solid var(--border, #26313d); border-left: 3px solid var(--accent, #4f8cff);
        border-radius: 8px; padding: 9px 10px; box-shadow: 0 10px 28px rgba(0,0,0,.35);
      }
      .toast.success { border-left-color: var(--ok, #3fb950); }
      .toast.error { border-left-color: var(--err, #f85149); }
      .toast.warning { border-left-color: var(--warn, #d29922); }
      .toast-head { display: flex; gap: 6px; align-items: flex-start; }
      .toast-title { flex: 1; font-weight: 700; font-size: 12px; }
      .toast-close { border: 0; background: none; color: var(--muted, #93a3b5); cursor: pointer; padding: 0 2px; font-size: 13px; }
      .toast-body { color: var(--muted, #93a3b5); font-size: 11px; margin-top: 2px; word-break: break-word; }
      .toast-action { margin-top: 6px; }
      .onboarding {
        position: fixed; inset: 0; z-index: 1800; display: flex;
        align-items: center; justify-content: center; padding: 24px;
        background: rgba(11,15,20,.62); backdrop-filter: blur(3px);
      }
      .onboarding[hidden] { display: none !important; }
      .onboarding-card {
        width: 100%; max-width: 560px; background: #141a22; color: #e6edf5;
        border: 1px solid #2a3442; border-radius: 16px; padding: 26px;
        box-shadow: 0 24px 70px rgba(0,0,0,.5);
        font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .onboarding-kicker { color: #93a3b5; font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 8px; }
      .onboarding-card h2 { margin: 0 0 10px; font-size: 23px; }
      .onboarding-body { color: #b8c5d3; min-height: 72px; }
      .onboarding-body ul { margin: 8px 0 0; padding-left: 18px; }
      .onboarding-body li { margin: 5px 0; }
      .onboarding-foot { display: flex; align-items: center; gap: 8px; margin-top: 22px; }
      .onboarding-foot .spacer { flex: 1; }
      .onboarding-foot .step { color: #93a3b5; font-size: 11px; }
      .onboarding-foot button {
        height: 32px; padding: 0 12px; border-radius: 7px;
        border: 1px solid #2a3442; background: #1b232d; color: #e6edf5;
        font: inherit; font-weight: 600; cursor: pointer;
      }
      .onboarding-foot button.primary { background: #4f8cff; border-color: #4f8cff; color: #0b0f14; }
      .drop-overlay {
        position: fixed; inset: 38px 0 0 0; background: rgba(11,15,20,.68);
        backdrop-filter: blur(3px); z-index: 1650;
        display: flex; align-items: center; justify-content: center; pointer-events: none;
      }
      .drop-card {
        background: var(--surface, #141a22); border: 1px dashed var(--accent, #4f8cff);
        border-radius: 14px; padding: 26px 34px; text-align: center; color: var(--text, #e6edf5);
        box-shadow: 0 18px 50px rgba(0,0,0,.45);
      }
      .drop-card strong { display: block; font-size: 16px; margin-bottom: 4px; }
      .drop-card span { color: var(--muted, #93a3b5); font-size: 11px; }
      button:focus-visible { outline: 2px solid var(--waf-brand, #4f8cff); outline-offset: 2px; }
      @media (max-width: 1180px) {
        .kbd { display: none; }
        .link, .action { padding: 0 6px; }
        .brand { padding-right: 6px; }
      }
    </style>
    <div class="bar ${platformClass} ${nativeClass}" role="navigation">
      <div class="brand">WOMBAT<span>pass</span></div>
      ${navButtons}
      <span class="spacer"></span>
      <button class="chip context" data-menu="context" aria-haspopup="menu" aria-label="Environment">
        <span class="healthdot"></span>
        <span class="chip-name">Environment</span>
        <span class="badge prod" hidden>PROD</span>
      </button>
      <button class="chip account" data-menu="account" aria-haspopup="menu" aria-label="Account">
        <span class="avatar">?</span>
        <span class="chip-name">Sign in</span>
      </button>
      <button class="action" data-action="palette"><span data-i18n="appbar.search">Search</span> <span class="kbd">${MOD}⇧K</span></button>
      <span class="split">
        <button class="action scan-main" data-action="scan-center"><span data-i18n="appbar.scan">Scan</span><span class="badge-count" id="scan-running" hidden>0</span></button>
        <button class="action scan-more" data-menu="scan" aria-label="Scan options" aria-haspopup="menu">▾</button>
      </span>
      <button class="chip watch" data-action="scan-center" hidden aria-label="Watching folder">● <span data-i18n="scan.watching">Watching</span></button>
      <button class="action bell" data-action="notifications" aria-label="Notifications" aria-haspopup="dialog">🔔<span class="badge-count" id="notif-count" hidden>0</span></button>
      <button class="chip update" id="update-chip" data-action="open-updates" hidden aria-label="Update available">⬆ <span class="chip-name">Update</span></button>
      <button class="action" data-action="stack"><span data-i18n="appbar.stack">Stack</span></button>
      <button class="action help" data-action="help"><span data-i18n="appbar.help">Help</span></button>
    </div>

    <div class="tabstrip" id="tabstrip" role="toolbar" aria-label="Open tabs" hidden></div>

    <div class="runbar" id="runbar" hidden role="region" aria-label="Run context">
      <span class="runbar-badge">RUN</span>
      <span class="runbar-project" id="runbar-project">—</span>
      <span class="runbar-score" id="runbar-score"></span>
      <span class="runbar-meta" id="runbar-meta"></span>
      <span class="runbar-spacer"></span>
      <button data-run-action="copy" data-i18n="run.copy">Copy link</button>
      <button data-run-action="window" data-i18n="run.newWindow">New window</button>
      <button data-run-action="findings" data-i18n="run.findings">Findings</button>
      <button data-run-action="compare" data-i18n="run.compare">Compare</button>
      <button class="runbar-close" data-run-action="close" aria-label="Close">✕</button>
    </div>

    <div class="offlinebar" id="offlinebar" hidden role="status" aria-live="polite">
      <span class="status-dot offline"></span>
      <strong id="offline-title">wombat-server unreachable</strong>
      <span id="offline-meta" class="offline-meta"></span>
      <span class="runbar-spacer"></span>
      <button data-offline-action="retry" data-i18n="offline.retry">Retry</button>
      <button data-offline-action="stack" data-i18n="offline.startStack">Start stack</button>
      <button data-offline-action="logs" data-i18n="offline.logs">Logs</button>
      <button data-offline-action="signin" data-i18n="auth.signIn" hidden>Sign in</button>
    </div>

    <div class="panel" id="scan-panel" role="dialog" aria-modal="false" aria-label="Scan center" hidden>
      <div class="panel-head">
        <strong class="panel-title" data-i18n="scan.title">Scan center</strong>
        <span class="panel-updated" id="scan-updated"></span>
        <button class="panel-close" data-close="scan" aria-label="Close">✕</button>
      </div>
      <div class="scan-actions">
        <button data-scan-action="clipboard" data-i18n="scan.clipboard">Clipboard</button>
        <button data-scan-action="folder" data-i18n="scan.folder">Folder</button>
        <button data-scan-action="watch" data-i18n="scan.watch">Watch folder</button>
        <button data-scan-action="stop-watch" data-i18n="scan.stopWatch">Stop watching</button>
        <button data-scan-action="cancel-all" data-i18n="scan.cancelAll">Cancel all</button>
      </div>
      <div class="panel-tabs">
        <select id="scan-filter" aria-label="Scan status">
          <option value="" data-i18n="scan.filterAll">All statuses</option>
          <option value="queued" data-i18n="scan.status.queued">Queued</option>
          <option value="running" data-i18n="scan.status.running">Running</option>
          <option value="succeeded" data-i18n="scan.status.succeeded">Succeeded</option>
          <option value="failed" data-i18n="scan.status.failed">Failed</option>
          <option value="cancelled" data-i18n="scan.status.cancelled">Cancelled</option>
        </select>
      </div>
      <div class="panel-body">
        <div class="panel-empty" id="scan-watch-status" hidden></div>
        <div id="scan-job-list" role="list"></div>
        <div class="panel-empty" id="scan-empty" data-i18n="scan.empty">No recent scans.</div>
        <div class="row-inline" style="padding: 4px 0 0;">
          <button id="scan-more" class="small" data-i18n="scan.loadMore" hidden>Load more</button>
        </div>
      </div>
    </div>

    <div class="panel" id="notification-panel" role="dialog" aria-modal="false" aria-label="Notifications" hidden>
      <div class="panel-head">
        <strong class="panel-title" data-i18n="notifications.title">Notifications</strong>
        <span class="panel-updated" id="notif-updated"></span>
        <button class="panel-close" data-close="notifications" aria-label="Close">✕</button>
      </div>
      <div class="panel-tabs">
        <button data-notif-filter="all" class="active" data-i18n="notifications.all">All</button>
        <button data-notif-filter="unread" data-i18n="notifications.unread">Unread</button>
        <select id="notif-category" aria-label="Notification category">
          <option value="" data-i18n="notifications.categoryAll">All categories</option>
          <option value="info" data-i18n="notifications.categoryInfo">Info</option>
          <option value="success" data-i18n="notifications.categorySuccess">Success</option>
          <option value="warning" data-i18n="notifications.categoryWarning">Warning</option>
          <option value="urgent" data-i18n="notifications.categoryUrgent">Urgent</option>
        </select>
        <button id="notif-mark-all" data-i18n="notifications.markAll">Mark all read</button>
      </div>
      <div class="panel-body" id="notif-list" role="list"></div>
      <div class="panel-empty" id="notif-status" hidden></div>
      <div class="row-inline" style="padding: 0 10px 10px;">
        <button id="notif-more" class="small" data-i18n="notifications.loadMore" hidden>Load more</button>
      </div>
    </div>

    <div class="toasts" id="toast-container" aria-live="polite" aria-atomic="false"></div>

    <div class="onboarding" id="onboarding" hidden>
      <div class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="onboarding-kicker" id="onboarding-kicker">Welcome</div>
        <h2 id="onboarding-title"></h2>
        <div class="onboarding-body" id="onboarding-body"></div>
        <div class="onboarding-foot">
          <span class="step" id="onboarding-step"></span>
          <span class="spacer"></span>
          <button id="onboarding-skip" data-i18n="onboarding.skip">Skip</button>
          <button class="primary" id="onboarding-next" data-i18n="onboarding.next">Next</button>
        </div>
      </div>
    </div>
    <div class="drop-overlay" id="drop-overlay" hidden>
      <div class="drop-card">
        <strong data-i18n="scan.dropTitle">Drop an IaC folder to scan</strong>
        <span data-i18n="scan.dropHint">Terraform, CloudFormation, Bicep, Pulumi or CDK files</span>
      </div>
    </div>
  `

  barRoot = shadow
  applyAppBarI18n()
  renderShellState(latestState)

  const links = [...shadow.querySelectorAll('.link')]
  let navFocus = 0

  function syncNavTabIndex() {
    links.forEach((button, index) => {
      button.tabIndex = index === navFocus ? 0 : -1
    })
  }

  function updateActive() {
    const route = String(location.hash || '')
      .replace(/^#\/?/, '')
      .split(/[?/]/)[0] || 'dashboard'
    let activeIndex = 0
    for (const [index, button] of links.entries()) {
      const active = button.dataset.route === route
      button.classList.toggle('active', active)
      if (active) {
        button.setAttribute('aria-current', 'page')
        activeIndex = index
      } else {
        button.removeAttribute('aria-current')
      }
    }
    navFocus = activeIndex
    syncNavTabIndex()
  }

  for (const [index, button] of links.entries()) {
    button.addEventListener('click', () => {
      navFocus = index
      syncNavTabIndex()
      navigate(button.dataset.route)
    })
    button.addEventListener('focus', () => {
      navFocus = index
      syncNavTabIndex()
    })
    button.addEventListener('keydown', (event) => {
      let next = null
      if (event.key === 'ArrowRight') next = (index + 1) % links.length
      else if (event.key === 'ArrowLeft') next = (index - 1 + links.length) % links.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = links.length - 1
      if (next === null) return
      event.preventDefault()
      navFocus = next
      syncNavTabIndex()
      links[next].focus()
    })
  }
  for (const button of shadow.querySelectorAll('.action, .chip[data-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.action
      if (action === 'scan-center') togglePanel('scan')
      else if (action === 'notifications') togglePanel('notifications')
      else ipcRenderer.invoke('appbar:action', action).catch(() => {})
    })
  }
  for (const button of shadow.querySelectorAll('[data-menu]')) {
    button.addEventListener('click', () => {
      ipcRenderer.invoke(`appbar:${button.dataset.menu}-menu`).catch(() => {})
    })
  }

  window.addEventListener('hashchange', () => {
    if (!normalizeRoute()) updateActive()
    syncRunBar()
  })
  // Hash routers can update via history.replaceState without a native
  // hashchange event; a cheap watcher keeps the active nav and run bar honest.
  let lastWatchedHash = location.hash
  setInterval(() => {
    const hash = location.hash
    if (hash === lastWatchedHash) return
    lastWatchedHash = hash
    if (!normalizeRoute()) updateActive()
    syncRunBar()
    reportTabRoute()
    maybeShowOnboarding()
  }, 400)
  if (!normalizeRoute()) updateActive()
  else updateActive()
  syncNavTabIndex()
  setupAppBarPanels()
  ipcRenderer.invoke('shell:perf-mark', 'dashboard-shell-ready').catch(() => {})
  applyShellLayout()
  syncRunBar()
  reportTabRoute()
  reportDashboardTheme()
  setInterval(reportDashboardTheme, 4_000)
  if (TABS_ENABLED) ipcRenderer.invoke('tabs:list').then(renderTabs).catch(() => {})
  ipcRenderer.invoke('onboarding:get').then((payload) => {
    onboardingPayload = payload
    maybeShowOnboarding()
  }).catch(() => {})
}

function injectSafeModeBanner() {
  if (document.getElementById('wombat-safe-mode')) return
  const host = document.createElement('div')
  host.id = 'wombat-safe-mode'
  host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2000;display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;background:#141a22;color:#e6edf5;border:1px solid #2a3442;box-shadow:0 10px 28px rgba(0,0,0,.35);font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
  const text = document.createElement('span')
  text.textContent = 'Safe mode: shell UI disabled'
  const button = document.createElement('button')
  button.textContent = 'Relaunch normally'
  button.style.cssText = 'height:24px;padding:0 8px;border-radius:6px;border:1px solid #2a3442;background:#1b232d;color:#e6edf5;font:inherit;font-weight:600;cursor:pointer;'
  button.addEventListener('click', () => window.wombatApp?.crashReload?.(false))
  host.append(text, button)
  document.documentElement.appendChild(host)
}

const IS_CRASH_PAGE = location.protocol === 'file:' && /\/crash\.html$/.test(location.pathname)
const SAFE_MODE = process.env.WOMBAT_SAFE_MODE === '1' || new URLSearchParams(location.search).has('safe')

if (!IS_CRASH_PAGE && !SAFE_MODE) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAppBar, { once: true })
  } else {
    injectAppBar()
  }
} else if (IS_CRASH_PAGE) {
  document.documentElement.dataset.shell = 'crash'
} else if (SAFE_MODE) {
  injectSafeModeBanner()
}
