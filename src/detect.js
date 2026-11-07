/**
 * Finds local wombat-server instances for the "Detect" button.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { resolveDockerBinary } from './docker-stack.js'

const execFileAsync = promisify(execFile)

const COMMON_PORTS = [8000, 8001, 3000, 8002, 8081]

async function probe(url) {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object') return null
    return { status: String(body.status ?? 'ok') }
  } catch {
    return null
  }
}

export async function detectServers() {
  const found = []
  const seen = new Set()

  const add = (url, source, status) => {
    if (seen.has(url)) return
    seen.add(url)
    found.push({ url, source, status })
  }

  await Promise.all(COMMON_PORTS.map(async (port) => {
    const url = `http://127.0.0.1:${port}`
    const hit = await probe(url)
    if (hit) add(url, `localhost:${port}`, hit.status)
  }))

  try {
    const { stdout } = await execFileAsync(
      resolveDockerBinary(),
      ['ps', '--format', '{{.Names}}\t{{.Ports}}'],
      { timeout: 4_000 },
    )
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, ports] = line.split('\t')
      if (!name || !ports) continue
      if (!/wombat|server/i.test(name)) continue
      for (const match of ports.matchAll(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):(\d+)->8000\/tcp/g)) {
        const url = `http://127.0.0.1:${match[1]}`
        if (seen.has(url)) continue
        const hit = await probe(url)
        add(url, `docker: ${name}`, hit?.status ?? 'unreachable')
      }
    }
  } catch {
    /* docker optional */
  }

  found.sort((a, b) => a.url.localeCompare(b.url))
  return found
}
