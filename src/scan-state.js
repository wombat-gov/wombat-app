/**
 * Scan job store (UI Wave U2).
 *
 * Normalizes `ScanJobOut` rows from `/api/v1/scans`, applies SSE progress /
 * failure events, and keeps the last 20 jobs for the scan center. The store is
 * deliberately pure/injectable so the reducer can be unit-tested without
 * Electron.
 */
const MAX_JOBS = 100
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const RUNNING = new Set(['queued', 'running'])

let jobs = []
const listeners = new Set()

function clone(value) {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

function normalize(job) {
  if (!job || typeof job !== 'object' || !job.id) return null
  const progress = Number(job.progress)
  return {
    id: String(job.id),
    status: String(job.status ?? 'queued'),
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    project: String(job.project ?? ''),
    path: String(job.path ?? ''),
    iac: String(job.iac ?? 'terraform'),
    branch: String(job.branch ?? ''),
    stage: String(job.stage ?? ''),
    triggered_by: String(job.triggered_by ?? ''),
    run_id: job.run_id ? String(job.run_id) : null,
    error: job.error ? String(job.error) : null,
    requested_by: String(job.requested_by ?? ''),
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
  }
}

function sortJobs(list) {
  return [...list].sort((a, b) => {
    const left = new Date(a.created_at ?? 0).getTime()
    const right = new Date(b.created_at ?? 0).getTime()
    return right - left
  })
}

function emit() {
  const snapshot = clone(jobs)
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch {
      /* listener errors must not break the store */
    }
  }
}

/** Pure reducer: apply one SSE scan event to a job list. */
export function reduceScanJobs(current, eventName, data = {}) {
  const jobId = data?.job_id ? String(data.job_id) : ''
  if (!jobId) {
    // scan.completed has no job id; the caller refreshes the list.
    return { jobs: current, changed: false, refresh: eventName === 'scan.completed' || eventName === 'run.created' }
  }

  const index = current.findIndex(job => String(job.id) === jobId)
  if (index < 0) return { jobs: current, changed: false, refresh: true }

  const job = { ...current[index] }
  if (eventName === 'scan.progress') {
    job.status = 'running'
    if (Number.isFinite(Number(data.progress))) {
      job.progress = Math.max(0, Math.min(100, Math.round(Number(data.progress))))
    }
    if (data.stage) job.stage = String(data.stage)
    if (data.project) job.project = String(data.project)
  } else if (eventName === 'scan.failed') {
    job.status = 'failed'
    job.error = data.error ? String(data.error) : job.error
    job.finished_at = job.finished_at || new Date().toISOString()
  } else if (eventName === 'scan.cancelled') {
    job.status = 'cancelled'
    job.finished_at = job.finished_at || new Date().toISOString()
  } else if (eventName === 'scan.started') {
    job.status = 'running'
    job.started_at = job.started_at || new Date().toISOString()
  } else {
    return { jobs: current, changed: false, refresh: false }
  }

  const next = [...current]
  next[index] = job
  return { jobs: next, changed: true, refresh: false }
}

export function setScanJobs(list) {
  jobs = sortJobs(
    (Array.isArray(list) ? list : []).map(normalize).filter(Boolean),
  ).slice(0, MAX_JOBS)
  emit()
  return clone(jobs)
}

export function upsertScanJob(job) {
  const normalized = normalize(job)
  if (!normalized) return clone(jobs)
  const index = jobs.findIndex(entry => entry.id === normalized.id)
  if (index >= 0) {
    jobs[index] = { ...jobs[index], ...normalized }
  } else {
    jobs = [normalized, ...jobs]
  }
  jobs = sortJobs(jobs).slice(0, MAX_JOBS)
  emit()
  return clone(jobs)
}

export function applyScanEvent(eventName, data) {
  const result = reduceScanJobs(jobs, eventName, data)
  if (result.changed) {
    jobs = sortJobs(result.jobs).slice(0, MAX_JOBS)
    emit()
  }
  return result
}

export function getScanJobs() {
  return clone(jobs)
}

export function getScanSummary() {
  return {
    jobs: clone(jobs),
    running: jobs.filter(job => RUNNING.has(job.status)).length,
    failed: jobs.filter(job => job.status === 'failed').length,
  }
}

export function subscribeScanJobs(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function refreshScanJobs(origin, options = {}) {
  if (!origin) return { ok: false, supported: false, jobs: getScanJobs(), message: 'Local server not ready.' }
  try {
    const { appFetch } = await import('./app-api.js')
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
    const params = new URLSearchParams({ limit: String(limit) })
    if (options.status) params.set('status', String(options.status))
    const response = await appFetch(origin, `/api/v1/scans?${params}`)
    if (response.status === 401) {
      return { ok: false, supported: true, signedIn: false, jobs: getScanJobs(), message: 'Sign in to load scan jobs.' }
    }
    if (response.status === 403) {
      return { ok: false, supported: true, signedIn: true, jobs: getScanJobs(), message: 'Engineer role required to view scan jobs.' }
    }
    if (response.status === 404 || response.status === 501) {
      return { ok: false, supported: false, jobs: getScanJobs(), message: 'This server does not support scan jobs.' }
    }
    if (!response.ok) {
      return { ok: false, supported: true, jobs: getScanJobs(), message: `HTTP ${response.status}` }
    }
    const json = await response.json()
    const next = setScanJobs(Array.isArray(json.data) ? json.data : [])
    return { ok: true, supported: true, jobs: next, total: Number(json.meta?.total ?? next.length) }
  } catch (error) {
    return {
      ok: false,
      supported: false,
      jobs: getScanJobs(),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const SCAN_TERMINAL_STATUSES = TERMINAL
