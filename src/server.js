/**
 * Loopback server for the built dashboard.
 *
 * The dashboard uses HttpOnly cookies, so it must be served from a real
 * http://127.0.0.1 origin rather than file://. A fixed port keeps the origin
 * stable across restarts (cookies, localStorage, and the SSO allowlist all
 * depend on it).
 *
 * API paths (/api, /health, /framework-update-info.yml) are reverse-proxied to
 * wombat-server. Same-origin proxying means the dashboard's cookie session and
 * CSRF double-submit work exactly as they do behind nginx in Docker.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 47823
const DEFAULT_TARGET = 'http://127.0.0.1:8000'

const PROXY_PATHS = ['/api', '/health', '/framework-update-info.yml']

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
}))

// The map worker is bundled with the dashboard; only map tiles and optional
// telemetry use the network.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    ...extra,
  }
}

function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  }))
  res.end(payload)
}

/** Resolve a URL pathname inside `root`, refusing traversal attempts. */
function resolveInside(root, pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0')) return null
  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`)
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (resolved !== root && !resolved.startsWith(prefix)) return null
  return resolved
}

async function findFile(root, pathname) {
  const candidate = resolveInside(root, pathname)
  if (!candidate) return null
  try {
    const stat = await fsp.stat(candidate)
    if (stat.isFile()) return { file: candidate, stat }
  } catch {
    /* not found */
  }
  return null
}

async function serveFile(req, res, { file, stat }, cacheControl) {
  const type = MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
  const headers = securityHeaders({
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  })
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

function isProxyPath(pathname) {
  return PROXY_PATHS.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Forward a request to wombat-server and stream the response back.
 *
 * Streaming (rather than buffering) matters for evidence ZIPs and large run
 * payloads. Cookies and CSRF headers pass through untouched: the browser sees
 * them as first-party on this origin, so SameSite=Lax/Strict keeps working.
 */
function proxyRequest(req, res, targetUrl, getAuthHeaders = () => ({}), onProxyResponse = null) {
  let target
  try {
    target = new URL(targetUrl)
  } catch {
    sendJson(res, 502, { detail: `Invalid wombat-server URL: ${targetUrl}` })
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendJson(res, 502, { detail: `Unsupported wombat-server protocol: ${target.protocol}` })
    return
  }

  const transport = target.protocol === 'https:' ? https : http
  const basePath = target.pathname.replace(/\/+$/, '')
  const headers = { ...req.headers }
  delete headers.host

  // Wave D: desktop device tokens authenticate remote environments. The
  // callback is sync (safeStorage decrypt) and must never override an
  // Authorization header the caller already supplied.
  try {
    const extra = getAuthHeaders() ?? {}
    for (const [name, value] of Object.entries(extra)) {
      if (!headers[name.toLowerCase()]) headers[name.toLowerCase()] = value
    }
  } catch {
    /* unsigned-in or secure storage unavailable: fall back to cookies */
  }

  const upstreamReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${basePath}${req.url ?? '/'}`,
    headers,
    timeout: 120_000,
  }, (upstreamRes) => {
    const responseHeaders = {}
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value
    }
    try {
      onProxyResponse?.(upstreamRes.statusCode ?? 502, req.url ?? '/')
    } catch {
      /* observer is diagnostic only */
    }
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
    upstreamRes.pipe(res)
  })

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timed out')))
  upstreamReq.on('error', (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, 502, {
      detail: `wombat-server unreachable at ${targetUrl}: ${error.message}`,
    })
  })

  req.pipe(upstreamReq)
}

/**
 * Start the local dashboard server.
 *
 * @param {object} opts
 * @param {string} opts.dashboardDir directory containing index.html
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {() => string} [opts.getTargetUrl] resolved per request, so changing
 *   the server URL in the app settings takes effect without a restart
 * @param {() => Record<string, string>} [opts.getAuthHeaders] extra upstream
 *   headers (e.g. a desktop device token) resolved per request
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>}>}
 */
export function startServer({
  dashboardDir,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  getTargetUrl = () => DEFAULT_TARGET,
  getAuthHeaders = () => ({}),
  onProxyResponse = null,
}) {
  const root = path.resolve(dashboardDir)
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    return Promise.reject(new Error(
      `Dashboard build not found at ${root}. Run "npm run build" in wafpass-dashboard first.`,
    ))
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`)
      const pathname = url.pathname

      if (isProxyPath(pathname)) {
        proxyRequest(req, res, getTargetUrl(), getAuthHeaders, onProxyResponse)
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { detail: 'Method not allowed.' })
        return
      }

      if (pathname === '/' || pathname === '') {
        const index = await findFile(root, '/index.html')
        await serveFile(req, res, index, 'no-cache')
        return
      }

      const hit = await findFile(root, pathname)
      if (hit) {
        const cacheControl = pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
        await serveFile(req, res, hit, cacheControl)
        return
      }

      // Client routes are hash-based, so a missing path with an extension is a
      // genuine 404; anything else falls back to the SPA shell.
      if (path.extname(pathname)) {
        sendJson(res, 404, { detail: 'Not found.' })
        return
      }
      const index = await findFile(root, '/index.html')
      await serveFile(req, res, index, 'no-cache')
    } catch (error) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : 'Internal error.' })
    }
  })

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({
        origin: `http://${host}:${actualPort}`,
        port: actualPort,
        close: () => new Promise((done) => {
          server.close(() => done())
          // Dashboard requests use keep-alive; without this, close() can wait
          // forever and block app.quit().
          server.closeAllConnections?.()
        }),
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

// ── Standalone mode: `node src/server.js` ────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const localBuild = path.resolve(here, '..', 'build', 'dashboard')
  const dashboardDir = process.env.WOMBAT_DASHBOARD_DIR
    ?? (fs.existsSync(path.join(localBuild, 'index.html'))
      ? localBuild
      : path.resolve(here, '..', '..', 'wafpass-dashboard', 'dist'))
  const port = Number(process.env.WOMBAT_PORT ?? DEFAULT_PORT)
  const target = (process.env.WOMBAT_SERVER_URL || DEFAULT_TARGET).replace(/\/+$/, '')

  startServer({ dashboardDir, port, getTargetUrl: () => target })
    .then(({ origin, close }) => {
      console.log(`[wombat-app] serving ${dashboardDir}`)
      console.log(`[wombat-app] ${origin}`)
      console.log(`[wombat-app] proxying /api, /health -> ${target}`)
      const shutdown = () => close().then(() => process.exit(0))
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((error) => {
      console.error(`[wombat-app] ${error instanceof Error ? error.message : error}`)
      process.exit(1)
    })
}
