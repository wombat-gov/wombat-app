/**
 * Local Docker stack helpers. Used by the tray action "Start Docker Stack"
 * and by the tray widget's container list.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { getPreferences, getServerUrl } from './config.js'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)

export function resolveDockerBinary() {
  const candidates = [
    process.env.WOMBAT_DOCKER_BIN,
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/usr/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    'C:\\ProgramData\\DockerDesktop\\cli-bin\\docker.exe',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return process.platform === 'win32' ? 'docker.exe' : 'docker'
}

function findComposeFile(dir) {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export async function startDockerStack() {
  const dir = getPreferences().dockerComposePath?.trim()
  if (!dir) return { ok: false, error: 'no-path' }

  const compose = findComposeFile(dir)
  if (!compose) return { ok: false, error: 'no-compose' }

  try {
    const { stdout, stderr } = await execFileAsync(
      resolveDockerBinary(),
      ['compose', '-f', compose, 'up', '-d'],
      { cwd: dir, timeout: 120_000 },
    )
    logger.info('docker compose up', { dir })
    return { ok: true, output: `${stdout}\n${stderr}`.trim().slice(-2_000) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('docker compose failed', { message })
    return { ok: false, error: message }
  }
}

export async function waitForHealth(url = getServerUrl(), timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return true
    } catch {
      /* keep waiting */
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  return false
}
