/**
 * electron-builder afterSign hook.
 *
 * Notarization is skipped unless APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
 * APPLE_TEAM_ID are set. It also requires a Developer ID signature; the
 * default build is ad-hoc signed with `mac.identity: null`, so remove that
 * line (or set CSC_NAME) when enabling notarization.
 */
const path = require('node:path')

module.exports = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('  • notarization skipped (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set)')
    return
  }

  const { notarize } = require('@electron/notarize')
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`  • notarizing ${appPath}`)
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  })
  console.log('  • notarized')
}
