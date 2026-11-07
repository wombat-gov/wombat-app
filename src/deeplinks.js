/**
 * Parsing for wombatpass:// deep links and command-line equivalents.
 *
 * Supported:
 *   wombatpass://run/<id>
 *   wombatpass://findings/<id>
 *   wombatpass://findings?run=<id>
 *   wombatpass://notifications
 *   wombatpass://scan?path=<folder>
 *   wombatpass://show/<route>?run=<id>
 *   --open-run <id>, --open-route <route>, --scan-path <folder>
 *
 * Routes are limited to dashboard pages the shell knows how to show.
 */
const ROUTES = new Set([
  'dashboard', 'findings', 'runs', 'waivers', 'risk', 'notifications',
  'runscan', 'evidence', 'compliance', 'regions', 'catalogue', 'pipelines',
  'audit', 'changes', 'diff', 'settings',
])

export function parseDeepLink(raw) {
  if (!raw) return null
  const value = String(raw).trim()
  if (!value.toLowerCase().startsWith('wombatpass:')) return null

  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const pathPart = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const runParam = url.searchParams.get('run') || null

  if (host === 'run') {
    return pathPart ? { runId: pathPart } : null
  }
  if (host === 'scan') {
    const scanPath = url.searchParams.get('path')
    if (scanPath) return { action: 'scan', path: scanPath }
    return { route: 'runscan' }
  }
  if (host === 'show') {
    const route = (pathPart || url.searchParams.get('route') || 'dashboard').toLowerCase()
    return ROUTES.has(route) ? { route, runId: runParam } : null
  }
  if (ROUTES.has(host)) {
    return { route: host, runId: runParam || (pathPart || null) }
  }
  return null
}

export function parseArgv(argv) {
  const args = argv.map(String)
  const links = []

  // Electron reorders argv on macOS (its own switches are inserted and the
  // value can end up at the end), so look ahead for a token that fits rather
  // than assuming the next element is the value.
  const findValue = (index, predicate) => {
    for (let j = index + 1; j < args.length; j += 1) {
      if (predicate(args[j])) return args[j]
    }
    return null
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg.startsWith('wombatpass://')) {
      const link = parseDeepLink(arg)
      if (link) links.push(link)
    } else if (arg === '--open-run') {
      const value = findValue(i, token => !token.startsWith('-') && token !== '.')
      if (value) links.push({ runId: value })
    } else if (arg.startsWith('--open-run=')) {
      links.push({ runId: arg.slice('--open-run='.length) })
    } else if (arg === '--open-route') {
      const value = findValue(i, token => ROUTES.has(token.toLowerCase()))
      if (value) links.push({ route: value.toLowerCase() })
    } else if (arg.startsWith('--open-route=')) {
      const route = arg.slice('--open-route='.length).toLowerCase()
      if (ROUTES.has(route)) links.push({ route })
    } else if (arg === '--scan-path') {
      const value = findValue(i, token => !token.startsWith('-') && token !== '.')
      if (value) links.push({ action: 'scan', path: value })
    } else if (arg.startsWith('--scan-path=')) {
      links.push({ action: 'scan', path: arg.slice('--scan-path='.length) })
    }
  }

  return links
}
