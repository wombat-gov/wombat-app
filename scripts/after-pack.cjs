/**
 * electron-builder afterPack hook.
 *
 * The build is intentionally unsigned (no Developer ID), but electron-builder
 * leaves the Electron binary's linker signature in place while adding
 * resources, which makes macOS report the bundle as damaged. Re-signing the
 * whole bundle ad-hoc produces a consistent signature that launches normally
 * from Finder/DMG on the machine that built it.
 */
const { execFileSync } = require('node:child_process')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
  console.log(`  • ad-hoc signed  ${appPath}`)
}
