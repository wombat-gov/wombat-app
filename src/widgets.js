/**
 * Data collection for the menu-bar widgets.
 *
 * The API is reached through the app's own loopback proxy, using the same
 * persistent session as the dashboard window. That keeps cookie auth working
 * for both local Docker and remote backends.
 *
 * Docker and run details are cached (60 s) so a 15 s refresh does not spawn a
 * `docker ps` and re-download the full findings list every time.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { session } from 'electron'

import { appFetch } from './app-api.js'
import { getActiveEnvironment, getPreferences, getServerUrl } from './config.js'
import { resolveDockerBinary } from './docker-stack.js'
import { logger } from './logger.js'
import { SESSION_PARTITION } from './security.js'

const execFileAsync = promisify(execFile)
const CONTAINER_MATCHER = /(wombat|postgres|keycloak)/i
const CACHE_TTL_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

let dockerCache = { at: 0, data: null }
const detailCache = new Map()
let summaryLogged = false

function requestInit(mandant) {
  const headers = { accept: 'application/json' }
  if (mandant) headers['X-Mandant-Context'] = String(mandant)
  return { credentials: 'include', headers }
}

function sessionFetch(url, init) {
  return session.fromPartition(SESSION_PARTITION).fetch(url, init)
}

async function collectDocker() {
  if (dockerCache.data && Date.now() - dockerCache.at < CACHE_TTL_MS) {
    return dockerCache.data
  }

  let data
  try {
    const { stdout } = await execFileAsync(
      resolveDockerBinary(),
      ['ps', '--format', '{{.Names}}\t{{.Status}}'],
      { timeout: 4_000 },
    )
    const containers = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, ...rest] = line.split('\t')
        const status = rest.join('\t')
        let state = 'err'
        if (/\(unhealthy\)/i.test(status) || /restarting/i.test(status)) state = 'warn'
        else if (/^Up\b/i.test(status)) state = 'ok'
        return { name, status, state, healthy: state === 'ok', up: /^Up\b/i.test(status) }
      })
      .filter(container => CONTAINER_MATCHER.test(container.name))
    data = { available: true, containers }
  } catch (error) {
    data = {
      available: false,
      containers: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  dockerCache = { at: Date.now(), data }
  return data
}

async function collectService() {
  const url = getServerUrl()
  const started = performance.now()

  let health
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    })
    const latencyMs = Math.round(performance.now() - started)
    const body = await response.json().catch(() => ({}))
    health = {
      ok: response.ok,
      status: response.ok ? String(body.status ?? 'ok') : `HTTP ${response.status}`,
      latencyMs,
      error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`,
    }
  } catch (error) {
    health = {
      ok: false,
      status: 'unreachable',
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    url,
    environment: getActiveEnvironment()?.name ?? '',
    environmentKind: getActiveEnvironment()?.kind ?? 'local',
    health,
    docker: await collectDocker(),
    canStartStack: Boolean(getPreferences().dockerComposePath?.trim()),
    checkedAt: new Date().toISOString(),
  }
}

function summariseRun(summary, detail) {
  const findings = detail?.findings ?? []
  const controlIds = [...new Set(findings.map(f => f.control_id).filter(Boolean))]

  let failedControls = 0
  let passedControls = 0
  let waivedControls = 0
  for (const cid of controlIds) {
    const statuses = findings
      .filter(f => f.control_id === cid)
      .map(f => String(f.status ?? '').toUpperCase())
    if (statuses.includes('WAIVED')) waivedControls += 1
    else if (statuses.includes('FAIL')) failedControls += 1
    else if (statuses.length > 0 && statuses.every(s => s === 'PASS')) passedControls += 1
  }

  const fails = findings.filter(f => String(f.status).toUpperCase() === 'FAIL')
  const passChecks = findings.filter(f => String(f.status).toUpperCase() === 'PASS').length
  const totalChecks = findings.length

  return {
    id: summary.id,
    project: summary.project || summary.branch || 'run',
    createdAt: summary.created_at,
    completedAt: summary.completed_at ?? null,
    stage: summary.stage ?? null,
    score: typeof summary.score === 'number' ? summary.score : null,
    iacFramework: summary.iac_framework ?? null,
    controlsRun: summary.controls_run ?? 0,
    controlsLoaded: summary.controls_loaded ?? 0,
    failedControls,
    passedControls,
    waivedControls,
    critical: fails.filter(f => String(f.severity).toUpperCase() === 'CRITICAL').length,
    high: fails.filter(f => String(f.severity).toUpperCase() === 'HIGH').length,
    passRate: totalChecks > 0 ? Math.round((passChecks / totalChecks) * 100) : null,
    hasDetail: Boolean(detail),
  }
}

async function fetchRunDetail(proxyOrigin, id, init) {
  const cached = detailCache.get(id)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

  const response = await sessionFetch(`${proxyOrigin}/api/v1/runs/${encodeURIComponent(id)}`, init)
  if (!response.ok) return null
  const data = (await response.json()).data ?? null
  detailCache.set(id, { at: Date.now(), data })
  if (detailCache.size > 20) {
    detailCache.delete(detailCache.keys().next().value)
  }
  return data
}

async function collectLatestScan(proxyOrigin, init) {
  try {
    const listResponse = await sessionFetch(`${proxyOrigin}/api/v1/runs?limit=50`, init)
    if (listResponse.status === 401) return { signedIn: false, run: null, error: null }
    if (!listResponse.ok) {
      return { signedIn: true, run: null, error: `HTTP ${listResponse.status}` }
    }

    const all = (await listResponse.json()).data ?? []
    const projects = [...new Set(all.map(run => run.project).filter(Boolean))].sort()
    const selectedProject = getPreferences().widgetProject || ''

    let runs = all.slice(0, 10)
    if (selectedProject) {
      try {
        const filtered = await sessionFetch(
          `${proxyOrigin}/api/v1/runs?limit=10&project=${encodeURIComponent(selectedProject)}`,
          init,
        )
        if (filtered.ok) {
          const json = await filtered.json()
          if (Array.isArray(json.data)) runs = json.data
        }
      } catch {
        /* fall back to all runs */
      }
      if (runs.length === 0) runs = all.slice(0, 10)
    }

    const latest = runs[0] ?? null
    const trend = runs
      .slice(0, 10)
      .map(run => (typeof run.score === 'number' ? run.score : null))
      .filter(score => score != null)
      .reverse()

    const dayAgo = Date.now() - DAY_MS
    const recent = all.filter((run) => {
      const time = new Date(run.created_at).getTime()
      return Number.isFinite(time) && time >= dayAgo
    })
    const digest = {
      runs24h: recent.length,
      projects24h: new Set(recent.map(run => run.project)).size,
    }

    let detail = null
    if (latest) {
      try {
        detail = await fetchRunDetail(proxyOrigin, latest.id, init)
      } catch {
        /* summary only is fine */
      }
    }

    return {
      signedIn: true,
      run: latest ? summariseRun(latest, detail) : null,
      projects,
      selectedProject,
      trend,
      digest,
      error: null,
    }
  } catch (error) {
    return {
      signedIn: null,
      run: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function collectNotifications(proxyOrigin, init) {
  try {
    const response = await sessionFetch(`${proxyOrigin}/api/v1/notifications`, init)
    if (response.status === 401) return { signedIn: false, unread: 0, latest: [] }
    if (!response.ok) return { signedIn: true, unread: 0, latest: [], error: `HTTP ${response.status}` }

    const json = await response.json()
    const items = Array.isArray(json.data) ? json.data : []
    const unreadItems = items.filter(item => !item.is_read)
    return {
      signedIn: true,
      unread: unreadItems.length,
      latest: unreadItems.slice(0, 3).map(item => ({
        title: item.title,
        category: item.category,
        createdAt: item.created_at,
      })),
    }
  } catch (error) {
    return {
      signedIn: null,
      unread: 0,
      latest: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function daysUntil(iso) {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return null
  return Math.ceil((time - Date.now()) / DAY_MS)
}

async function collectGovernance(proxyOrigin, init) {
  const get = async (path) => {
    try {
      const response = await sessionFetch(`${proxyOrigin}${path}`, init)
      if (!response.ok) return []
      const json = await response.json()
      return Array.isArray(json.data) ? json.data : []
    } catch {
      return []
    }
  }

  const [waivers, risks] = await Promise.all([
    get('/api/v1/waivers'),
    get('/api/v1/risks'),
  ])

  const items = []
  for (const waiver of waivers) {
    if (waiver.expires) items.push({ type: 'waiver', project: waiver.project, expires: waiver.expires, days: daysUntil(waiver.expires) })
  }
  for (const risk of risks) {
    if (risk.expires) items.push({ type: 'risk', project: risk.project, expires: risk.expires, days: daysUntil(risk.expires) })
  }

  const expired = items.filter(item => item.days != null && item.days < 0)
  const expiring = items.filter(item => item.days != null && item.days >= 0 && item.days <= 7)
  const next = [...expired, ...expiring]
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
    .slice(0, 3)

  return {
    waivers: waivers.length,
    risks: risks.length,
    expired: expired.length,
    expiring: expiring.length,
    next,
  }
}

export async function collectWidgetData(proxyOrigin, options = {}) {
  const init = requestInit(options.mandant)
  const project = getPreferences().widgetProject || ''
  const summary = await collectSummary(proxyOrigin, init, project)

  if (summary.data) {
    if (!summaryLogged) {
      summaryLogged = true
      logger.info('widgets: using desktop summary endpoint')
    }
    const service = await collectService()
    return {
      generatedAt: summary.data.generated_at ?? new Date().toISOString(),
      service,
      ...summaryToWidgetData(summary.data, project),
    }
  }

  if (summary.signedIn === false) {
    return {
      generatedAt: new Date().toISOString(),
      service: await collectService(),
      scan: { signedIn: false, run: null, projects: [], selectedProject: project, trend: [], digest: null, error: null },
      notifications: { signedIn: false, unread: 0, latest: [] },
      governance: { waivers: 0, risks: 0, expired: 0, expiring: 0, next: [] },
    }
  }

  // Older server (summary endpoint absent) or a transient summary failure:
  // keep the pre-Wave-A multi-call path.
  const [service, scan, notifications, governance] = await Promise.all([
    collectService(),
    collectLatestScan(proxyOrigin, init),
    collectNotifications(proxyOrigin, init),
    collectGovernance(proxyOrigin, init),
  ])

  return { generatedAt: new Date().toISOString(), service, scan, notifications, governance }
}

async function collectSummary(proxyOrigin, init, project) {
  const query = project ? `?project=${encodeURIComponent(project)}` : ''
  try {
    const response = await appFetch(proxyOrigin, `/api/v1/desktop/summary${query}`, {
      headers: init?.headers ?? {},
    })
    if (response.status === 401) return { signedIn: false }
    if (response.status === 404 || response.status === 501) return { unsupported: true }
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const json = await response.json()
    return { data: json.data ?? json }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function summaryToWidgetData(summary, project) {
  const latest = summary.latest_run
  const run = latest
    ? {
        id: latest.id,
        project: latest.project,
        createdAt: latest.created_at,
        completedAt: latest.completed_at ?? null,
        stage: latest.stage ?? null,
        score: typeof latest.score === 'number' ? latest.score : null,
        iacFramework: latest.iac_framework ?? null,
        controlsRun: latest.controls_run ?? 0,
        controlsLoaded: latest.controls_loaded ?? 0,
        failedControls: latest.failed_controls ?? 0,
        critical: latest.critical ?? 0,
        high: latest.high ?? 0,
        passRate: latest.pass_rate ?? null,
        hasDetail: true,
      }
    : null

  return {
    scan: {
      signedIn: true,
      run,
      projects: summary.projects ?? [],
      selectedProject: summary.selected_project ?? project,
      trend: summary.trend ?? [],
      digest: summary.digest
        ? {
            runs24h: summary.digest.runs_24h ?? 0,
            projects24h: summary.digest.projects_24h ?? 0,
          }
        : { runs24h: 0, projects24h: 0 },
      error: null,
    },
    notifications: {
      signedIn: true,
      unread: summary.notifications?.unread ?? 0,
      latest: [],
    },
    governance: summary.governance ?? { expiring: 0, expired: 0, next: [] },
  }
}
