/**
 * Generate the SBOM overview (src/sbom.json) and a CycloneDX document
 * (build/sbom.cdx.json).
 *
 * Scope: the Electron runtime plus the dashboard's direct production
 * dependencies. Build/test tooling (electron-builder, notarize, playwright)
 * is intentionally excluded.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')
const dashboardDir = path.resolve(appDir, '..', 'wafpass-dashboard')

const appPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const dashboardPkg = JSON.parse(fs.readFileSync(path.join(dashboardDir, 'package.json'), 'utf8'))

function readPackage(baseDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, 'node_modules', name, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function normalizeLicense(pkg) {
  const license = pkg?.license
  if (typeof license === 'string') return license
  if (license && typeof license === 'object' && typeof license.type === 'string') return license.type
  if (Array.isArray(pkg?.licenses)) {
    const types = pkg.licenses
      .map(entry => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean)
    if (types.length) return types.join(', ')
  }
  return 'UNKNOWN'
}

const components = []

for (const name of Object.keys(dashboardPkg.dependencies ?? {})) {
  const pkg = readPackage(dashboardDir, name)
  components.push({
    name,
    version: pkg?.version ?? String(dashboardPkg.dependencies[name]).replace(/^[^0-9]*/, ''),
    license: normalizeLicense(pkg),
    scope: 'dashboard',
  })
}

// Electron is the desktop runtime. The dashboard's direct deps above are the
// only other runtime code shipped in the bundle.
const electronPkg = readPackage(appDir, 'electron')
if (electronPkg) {
  components.push({
    name: 'electron',
    version: electronPkg.version,
    license: normalizeLicense(electronPkg),
    scope: 'app',
  })
}

components.sort((a, b) => a.name.localeCompare(b.name))

const licenseCounts = {}
for (const component of components) {
  licenseCounts[component.license] = (licenseCounts[component.license] ?? 0) + 1
}

const sbom = {
  generatedAt: new Date().toISOString(),
  app: {
    name: appPkg.productName ?? appPkg.name,
    version: appPkg.version,
  },
  components,
  summary: {
    count: components.length,
    licenses: licenseCounts,
    note: 'Direct runtime dependencies. Build/test tooling excluded. Electron bundles Chromium and Node.js under their own licenses.',
  },
}

await fsp.mkdir(path.join(appDir, 'src'), { recursive: true })
await fsp.writeFile(path.join(appDir, 'src', 'sbom.json'), `${JSON.stringify(sbom, null, 2)}\n`)

const cyclone = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: sbom.generatedAt,
    tools: [{ vendor: 'WOMBAT', name: 'make-sbom', version: '1.0.0' }],
    component: {
      type: 'application',
      name: sbom.app.name,
      version: sbom.app.version,
    },
  },
  components: components.map(component => ({
    type: 'library',
    name: component.name,
    version: component.version,
    scope: 'required',
    ...(component.license === 'UNKNOWN'
      ? {}
      : { licenses: [{ license: { id: component.license.split(', ')[0] } }] }),
  })),
}

await fsp.mkdir(path.join(appDir, 'build'), { recursive: true })
await fsp.writeFile(path.join(appDir, 'build', 'sbom.cdx.json'), `${JSON.stringify(cyclone, null, 2)}\n`)

console.log(`[sbom] ${components.length} components`)
for (const [license, count] of Object.entries(licenseCounts)) {
  console.log(`[sbom]   ${license}: ${count}`)
}
console.log('[sbom] wrote src/sbom.json and build/sbom.cdx.json')
