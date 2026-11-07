# Native window chrome spike — result (UI Wave U0)

Tested on macOS (Darwin 27, Apple Silicon) with the app from `wombat-app/`.

## Implemented

- **macOS:** `titleBarStyle: 'hiddenInset'` with `trafficLightPosition: { x: 12, y: 12 }`.
  The injected app bar is the drag region (`-webkit-app-region: drag`); links,
  action buttons, the brand and their children are `no-drag`. The bar reserves
  84 px on the left so the traffic lights never overlap the first nav item.
- **Windows:** `titleBarStyle: 'hidden'` + `titleBarOverlay` (38 px, dark
  defaults). The bar reserves 150 px on the right for the system controls.
  This path compiles and is guarded, but could not be visually verified on this
  machine — **needs Windows 11 QA in U5**.
- **Linux:** standard frame; no custom chrome.
- **Rollback:** `WOMBAT_NATIVE_CHROME=0` restores the previous frame for every
  platform. The preload derives the `native-chrome` class from the same flag,
  so padding and drag regions disappear together.

## Verification

- `tests/ui-foundations.mjs` asserts `platform-darwin` + `native-chrome` and
  the 84 px left padding on macOS.
- Smoke, palette, device-auth and a11y tests pass with the new chrome.
- App bar navigation remains clickable; arrow-key navigation still works.

## Follow-ups for U5

1. Verify Windows overlay colors follow light/dark theme (`setTitleBarOverlay`
   on theme changes).
2. Check full-screen and maximized layouts, multiple monitors, and narrow
   windows.
3. Consider `titleBarStyle: 'hidden'` for Settings/Help if the double frame
   looks inconsistent — currently only dashboard windows use native chrome.
4. Take screenshots on all three platforms as the U5 visual baseline.

## U5 productionization

- Settings → Appearance now has **Use native window chrome** (restart required)
  and **Restore open tabs on launch**.
- The chrome decision is passed to each dashboard window via
  `additionalArguments: --wombat-native-chrome=0|1`, so reloading Settings does
  not desynchronize the app-bar padding from the actual frame.
- A custom tab strip is used on Windows/Linux (and with `WOMBAT_UI_TABS=1` for
  testing); macOS keeps native tab grouping when the custom strip is off.
