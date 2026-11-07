/**
 * Scan job store reducer tests (UI Wave U2). Pure Node, no Electron.
 */
import assert from 'node:assert/strict'

import {
  getScanJobs,
  getScanSummary,
  reduceScanJobs,
  setScanJobs,
  upsertScanJob,
} from '../src/scan-state.js'

const base = {
  id: 'job-1',
  status: 'queued',
  progress: 0,
  project: 'demo',
  path: '/tmp/demo',
  iac: 'terraform',
  branch: 'main',
  stage: 'desktop',
  run_id: null,
  error: null,
  created_at: '2026-11-07T10:00:00Z',
}

// Progress updates an existing job.
let result = reduceScanJobs([base], 'scan.progress', { job_id: 'job-1', progress: 40, stage: 'scanning' })
assert.equal(result.changed, true)
assert.equal(result.jobs[0].status, 'running')
assert.equal(result.jobs[0].progress, 40)
assert.equal(result.jobs[0].stage, 'scanning')

// Failure marks terminal and keeps the error.
result = reduceScanJobs(result.jobs, 'scan.failed', { job_id: 'job-1', error: 'boom' })
assert.equal(result.jobs[0].status, 'failed')
assert.equal(result.jobs[0].error, 'boom')

// scan.completed has no job id and asks the caller to refresh.
result = reduceScanJobs([base], 'scan.completed', { run_id: 'run-1' })
assert.equal(result.refresh, true)
assert.equal(result.changed, false)

// Unknown job triggers a refresh.
result = reduceScanJobs([], 'scan.progress', { job_id: 'missing', progress: 5 })
assert.equal(result.refresh, true)

// Store upsert/dedupe/order/summary.
setScanJobs([])
upsertScanJob(base)
upsertScanJob({ ...base, status: 'running', progress: 20 })
assert.equal(getScanJobs().length, 1)
assert.equal(getScanJobs()[0].status, 'running')
assert.equal(getScanSummary().running, 1)

upsertScanJob({ ...base, id: 'job-2', created_at: '2026-11-07T11:00:00Z' })
assert.equal(getScanJobs()[0].id, 'job-2')
assert.equal(getScanJobs().length, 2)

setScanJobs(new Array(30).fill(null).map((_, index) => ({
  ...base,
  id: `job-${index}`,
  created_at: `2026-11-07T${String(index % 24).padStart(2, '0')}:00:00Z`,
})))
assert.equal(getScanJobs().length, 30)
assert.equal(getScanSummary().failed, 0)

console.log('scan-state ok — reducer, upsert, ordering, bounded store')
