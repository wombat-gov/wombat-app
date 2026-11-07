/**
 * Build the dashboard bundle used by the desktop app.
 *
 * Differences from the normal dashboard build:
 *   - VITE_API_URL is empty, so the renderer calls /api on its own origin and
 *     the Electron loopback server proxies it to wombat-server.
 *   - output goes to wombat-app/build/dashboard instead of wafpass-dashboard/dist
 *   - sourcemaps are removed (not needed in the packaged app)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')
const dashboardDir = path.resolve(appDir, '..', 'wafpass-dashboard')
const outDir = path.join(appDir, 'build', 'dashboard')

if (!(await fs.stat(path.join(dashboardDir, 'package.json')).catch(() => null))) {
  console.error(`[build-dashboard] dashboard not found at ${dashboardDir}`)
  process.exit(1)
}

console.log(`[build-dashboard] building ${dashboardDir} -> ${outDir}`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npm, ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir'], {
  cwd: dashboardDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: '' },
})

const exitCode = await new Promise((resolve) => {
  child.on('exit', code => resolve(code ?? 1))
  child.on('error', (error) => {
    console.error(`[build-dashboard] ${error.message}`)
    resolve(1)
  })
})

if (exitCode !== 0) {
  console.error(`[build-dashboard] dashboard build failed (exit ${exitCode})`)
  process.exit(exitCode)
}

async function stripSourcemaps(dir) {
  let removed = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      removed += await stripSourcemaps(full)
    } else if (entry.name.endsWith('.map')) {
      await fs.rm(full, { force: true })
      removed += 1
    }
  }
  return removed
}

const removed = await stripSourcemaps(outDir)
console.log(`[build-dashboard] done — removed ${removed} sourcemap(s)`)

/**
 * The dashboard hardcodes a jsDelivr URL for the maplibre worker. Ship the
 * worker with the bundle instead: fewer third-party origins in the CSP and the
 * map keeps working offline.
 */
async function selfHostMapWorker() {
  const maplibreDist = path.join(dashboardDir, 'node_modules', 'maplibre-gl', 'dist')
  const workerDir = path.join(outDir, 'assets', 'maplibre')

  const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
  try {
    await fs.mkdir(workerDir, { recursive: true })
    for (const file of files) {
      await fs.copyFile(path.join(maplibreDist, file), path.join(workerDir, file))
    }
  } catch (error) {
    console.warn(`[build-dashboard] could not self-host maplibre worker: ${error.message}`)
    return
  }

  const assetsDir = path.join(outDir, 'assets')
  let patched = 0
  for (const entry of await fs.readdir(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = path.join(assetsDir, entry.name)
    const source = await fs.readFile(file, 'utf8')
    if (!source.includes('cdn.jsdelivr.net/npm/maplibre-gl')) continue
    const next = source.replace(
      /https:\/\/cdn\.jsdelivr\.net\/npm\/maplibre-gl@[^"'`\s]+\/dist\/maplibre-gl-worker\.mjs/g,
      '/assets/maplibre/maplibre-gl-worker.mjs',
    )
    if (next !== source) {
      await fs.writeFile(file, next)
      patched += 1
    }
  }
  console.log(`[build-dashboard] self-hosted maplibre worker (${patched} chunk(s) patched)`)
}

await selfHostMapWorker()
console.log('[build-dashboard] start the app with: npm start')
