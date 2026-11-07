# UI plan — desktop shell polish (Wave U)

> **Status (2026-11-07):** U0–U5 are implemented (app `0.16.0`). All planned
> UI waves are complete. App baseline before U0: `0.10.0`.
>
> Scope: the Electron shell only. The dashboard stays unmodified (no fork, no
> second build). No new backend wave is required: scan jobs, notifications,
> global search and device authorization already exist.

This plan covers all 13 proposed UI updates. They are grouped into six waves
(U0–U5). Each wave is independently shippable, has an explicit exit gate, and
keeps a feature flag for rollback.

---

## Goals

- Make the desktop chrome tell you **where you are, who you are, and whether
  the backend is healthy** without opening Settings.
- Make scanning and notifications **visible** instead of modal or hidden in the
  tray.
- Make the shell feel native on macOS, Windows and Linux without forking the
  dashboard.
- Fix theme, language and accessibility as **foundations**, not as a follow-up
  cleanup.
- Never expose device tokens, CSRF secrets or config contents to a renderer.

## Principles

1. **Main process is the source of truth.** Renderers receive display-only
   snapshots and send allowlisted actions.
2. **Additive shell.** The dashboard remains untouched; app bar, panels and
   overlays live in the preload shadow DOM.
3. **Feature-detect the server.** If `/scans`, `/notifications`, `/search` or
   `/auth/devices` is unavailable, hide the new UI and fall back to the old
   path.
4. **Cross-platform by design.** Platform-specific chrome is guarded and
   flag-controlled; no macOS-only assumptions leak into shared code.
5. **Ship in slices.** Every wave ends with tests, an app package, and a rollback
   flag.

## Baseline and gaps

Existing: app bar, command palette (server-ranked), Settings window, tray
popover, scan zone/watch, stack console, Help/About/SBOM/diagnostics, device
sign-in in Settings, native macOS tabs.

Gaps this plan addresses:

| # | Update | Current gap |
|---|--------|-------------|
| 1 | App-bar context chip | No environment, health or user in the bar |
| 2 | Scan center | Progress only in the scan-zone window; no history or global drop |
| 3 | Toasts + notification center | OS notifications only; no in-app feedback or bell |
| 4 | Settings tabs | One long scroll; device auth made it longer |
| 5 | Theme, i18n, accessibility | Shell windows are fixed dark; strings/ARIA incomplete |
| 6 | Account & devices panel | No device list/revoke UI |
| 7 | Run context bar | No project/score/actions strip while viewing a run |
| 8 | Palette 2.0 | No filters, recents or shell commands |
| 9 | Update experience | Check-only dialog; no banner/progress/notes |
| 10 | Offline/crash UX | Native error dialogs, no persistent offline state |
| 11 | Native window chrome | Double title bar; app bar is not the drag region |
| 12 | Cross-platform tabs | Only macOS gets tabs; Windows/Linux get loose windows |
| 13 | Onboarding / What’s New | Features discoverable only via menus and shortcuts |

## Waves at a glance

| Wave | Theme | Items | Estimate | Version |
|---|---|---|---|---|
| U0 | Foundations: state, theme, i18n, a11y; native-chrome spike | 5 (foundation), 11 (spike) | 3–4 d | `0.11.0` |
| U1 | Context, identity and Settings | 1, 4, 6, production guard | 4–5 d | `0.12.0` |
| U2 | Scan center and notifications | 2, 3 | 5–6 d | `0.13.0` |
| U3 | Run context and palette 2.0 | 7, 8 | 3–4 d | `0.14.0` |
| U4 | Resilience and updates | 9, 10 | 3–4 d | `0.15.0` |
| U5 | Platform chrome, tabs, onboarding | 11, 12, 13 | 6–8 d | `1.0.0` |

Estimates are relative dev-days for one engineer familiar with the codebase.
Total: roughly 24–31 dev-days, excluding review and platform QA.

---

# Wave U0 — Foundations

**Goal:** one shell state stream, one theme system, one translation layer, and
accessible primitives that every later wave uses. Also de-risk native window
chrome with a small spike before the app bar is redesigned.

## U0.1 Desktop state hub — `src/desktop-state.js`

A main-process store, not a renderer store.

```js
{
  environment: {
    id, name, url, kind,            // local | staging | production
    health: 'connected'|'degraded'|'offline',
    latencyMs, serverVersion, lastSyncAt
  },
  auth: {
    signedIn, method: 'cookie'|'device'|'none',
    user: { username, displayName, role } | null,
    device: { id, name, lastUsedAt } | null
  },
  connection: { state, since, error },
  notifications: { unread },
  scan: {
    watching: { active, path },
    running: n,
    jobs: [ /* recent ScanJobOut */ ]
  },
  update: { state, current, latest, notes, progress },
  ui: { theme, effectiveTheme, locale, highContrast, reducedMotion }
}
```

- `getSnapshot()`, `patch(partial)`, `subscribe(listener)`.
- Broadcast `shell:state` to all app windows, coalesced to ~250 ms so a burst of
  SSE events does not flood renderers.
- Sources of truth: `tray.js` summary/SSE loop, `widgets.js`, `events.js`,
  `device-auth.js`, `scan-folder.js`, `updates.js`, health probes.
- Phase 1: dual-write (existing controllers keep working). Phase 2 (in U2):
  move tray/widget polling into the hub and have the tray subscribe.
- IPC: `shell:get-state`, `shell:action` (allowlisted command dispatch),
  `shell:state` push.

**Exit gate:** all windows receive state; tray and app bar show the same
environment/health; no token or config secret is in any snapshot.

## U0.2 Theme system

- New `src/shell-theme.css` with tokens for dark, light, and
  `prefers-contrast: more`.
- Standalone windows (`settings`, `palette`, `help`, `scan-zone`, `logs`,
  `popover`) link the shared stylesheet; CSP changes from
  `style-src 'unsafe-inline'` to `style-src 'self' 'unsafe-inline'`.
- The in-page app bar keeps inheriting dashboard CSS variables but gets
  complete light fallbacks, so it also works when the dashboard omits a token.
- `nativeTheme.themeSource` follows a preference: `system | light | dark`.
  Broadcast `shell:theme`; windows set `document.documentElement.dataset.theme`.
- High contrast: `nativeTheme.shouldUseHighContrastColors` → `data-contrast`.
- Reduced motion: preference + `@media (prefers-reduced-motion: reduce)`.
- Windows title-bar overlay (in U5) reads the same resolved colors.
- macOS menu-bar icons: verify template-image rendering in both themes; add
  light/dark assets if needed.

**Exit gate:** all shell windows render correctly in light/dark/high-contrast;
no hardcoded `#0b0f14` remains outside token definitions.

## U0.3 i18n plumbing

- Expand `src/i18n.js` to en/de for app bar, palette, scan center, toasts,
  Settings tabs, onboarding and update strings.
- `preferences.locale` override (`system | en | de`); `getLocale()` respects it.
- Broadcast `shell:i18n`; preloads expose `t(key, fallback)`.
- Help/About body content may stay English in this wave; headings and controls
  must be translatable.
- Add a CI-style check script `scripts/check-i18n.mjs` that fails on missing keys
  in either locale.

**Exit gate:** switching locale updates app bar, palette, Settings and toasts
without restart; key-parity check is green.

## U0.4 Accessibility primitives

- Shared focus-ring tokens; visible focus on every shell control.
- Keyboard model:
  - app bar: roving tabindex, Arrow keys between items, Enter/Space activate,
    Esc closes any open panel.
  - listbox pattern for palette and notification list: `role=listbox`,
    `role=option`, `aria-activedescendant`, live region for result counts.
  - Settings tabs: `role=tablist/tab/tabpanel`, Arrow keys.
  - Toast stack: `role=status`, `aria-live=polite`; errors `aria-live=assertive`.
- All icon-only buttons (`bell`, `account`, `close`) get `aria-label`.
- Add `axe-core` as a dev dependency; run it against local HTML windows in a
  new `tests/a11y.mjs` (via injected source, so CSP is not an issue).
- Manual check: complete the main flows with keyboard only and VoiceOver
  (macOS) / Narrator (Windows).

**Exit gate:** axe reports no critical/serious issues on Settings, palette,
Help and the dashboard shell overlay; keyboard-only smoke passes.

## U0.5 Native chrome spike (feeds U5)

- macOS: `titleBarStyle: 'hiddenInset'`, traffic-light position, drag region on
  the app bar, `no-drag` on interactive controls, brand padding.
- Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay` height 38.
- Linux: keep the standard frame.
- Behind `WOMBAT_NATIVE_CHROME=0` rollback.
- Deliver a short decision note: ship in U1 or defer to U5 depending on layout
  stability.

**Exit gate:** macOS window has no double title bar; traffic lights do not
overlap the bar and all buttons remain clickable; Windows code path compiles
behind a platform guard.

---

# Wave U1 — Context, identity and Settings

**Goal:** answer “where am I / who am I / is this production?” in the app bar,
and turn Settings into a structured window with device management.

## U1.1 Environment kind and production guard

- Extend environments with `kind: 'local' | 'staging' | 'production'`
  (default `local`). Preserve it in `cleanEnvironments`/`saveEnvironments`.
- Settings → Connection adds a Type select.
- `isProductionEnvironment(env)` checks `kind`, never guesses from the URL.
- Production treatment:
  - `PROD` badge in the context chip and tray.
  - Amber/red accent for the chip and window title suffix.
  - Confirmation dialog before Stack Stop/Restart and before revoking the
    current device.
- No read-only mode in this wave.

## U1.2 App-bar context chip (item 1)

Add to `src/preload.cjs`:

```
[● Local Docker ▾]   [admin ▾]   [Search ⌘⇧K]   [Scan ▾]   [🔔 2]   [Help]
```

- Context chip: status dot (health), environment name, `PROD` badge, tooltip
  with URL/latency/version/last sync.
- Click opens a **native menu** (`Menu.popup`) via `appbar:context-menu`:
  - Environments (radio list, switch immediately)
  - Test connection
  - Server Settings…
  - Open logs
- Data comes from `shell:state`; no direct fetch in the preload.
- Keep the existing nav links and Search behavior.

## U1.3 Account chip and menu (item 6, part 1)

- Account chip shows initials/avatar and user when signed in, or “Sign in” when
  not.
- Native menu:
  - Signed in as `<user>` (disabled row)
  - Device status / browser-session status
  - Manage devices… (opens Settings → Sign-in & devices)
  - Sign in with browser… (runs the existing device flow for the active env)
  - Sign out device (confirmation)
  - Server Settings…
- The chip reflects `auth.method`: cookie session vs device token.
- If the backend is offline, the account menu shows “Unavailable” instead of
  pretending to be signed out.

## U1.4 Settings tabs (item 4)

Rewrite `settings.html` into five tabs with a sticky footer:

1. **Connection** — environment select/name/url/type, Detect, Test, status.
2. **Sign-in & devices** — device status, Sign in with browser, Sign out,
   device table (name, created, last used, current, revoke). Revoking the
   current device asks for confirmation and then signs out.
3. **Appearance** — theme (`system/light/dark`), locale (`system/en/de`),
   density (`comfortable/compact`), launch at login, start minimized, dock,
   menu-bar text.
4. **Scans** — Docker Compose path, watch defaults, upload limits (read-only
   info), “Open Scan center”.
5. **Advanced** — update feed, logs, config path, diagnostics, reset onboarding.

- Keep existing element IDs (`#server-url`, `#device-signin`, …) so current
  tests and muscle memory survive.
- Single in-memory form model; switching tabs must not lose edits.
- `openSettings({ tab })` in main, used by the app bar/tray/palette.
- Window grows to ~720×820 with an internal scroll region; resizable.

## U1.5 Tray consistency

- Tray popover shows environment kind and auth state.
- “Manage devices…” / “Sign in…” entries mirror the account menu.
- Tray and app bar read the same `shell:state` snapshot.

**Exit gate:** switching environments from the bar works; production badge and
confirmations work; Settings tabs save correctly; device list/revoke E2E passes;
existing smoke/palette/device tests updated and green.

---

# Wave U2 — Scan center and notifications

**Goal:** make background work visible and actionable.

## U2.1 Scan job store — `src/scan-state.js`

- Pure reducer over `ScanJobOut` plus SSE events:
  `scan.progress`, `scan.completed`, `scan.failed`, `scan.cancelled`.
- Main keeps the last 20 jobs. Poll `GET /api/v1/scans?limit=20` when the panel
  is open or a job is running; SSE updates in between.
- Actions: cancel queued/running, open run, “scan again” (re-submit only when
  the original path is still valid; uploaded jobs are cleaned up, so they offer
  “choose folder” instead).
- Publish `scan` state through the hub.

## U2.2 Scan button, menu and global drop (item 2, part 1)

- App bar `Scan` becomes a split button:
  - Main click opens the Scan center.
  - Chevron opens a native menu: Clipboard, Folder, Watch Folder, Stop Watching.
- Global drop target in the dashboard window:
  - `dragover` shows a full-window overlay (“Drop an IaC folder to scan”).
  - Use `webUtils.getPathForFile(file)` in the preload; validate the path is a
    directory; Esc cancels.
  - `drop` sends `scan:drop` to the existing controller.
- While watching, show a compact chip: `Watching ~/iac · Stop`.

## U2.3 Scan center panel (item 2, part 2)

Injected panel under the app bar:

- Active job: progress bar, stage, project, elapsed, Cancel.
- Recent jobs: status, project, duration, score, error; actions Open run,
  Scan again, Cancel, Clear finished.
- Empty state with the three scan modes and a “drop a folder” hint.
- The panel is a dialog (`role=dialog`, focus trap, Esc closes) but non-modal
  for background jobs.

## U2.4 Toast host (item 3, part 1)

- Main service `src/toasts.js` publishes `{id, level, title, body, action, ttl}`
  to every window via `shell:toast`.
- Events:
  - scan completed / failed / cancelled
  - device sign-in success / failure
  - backend connection lost / restored
  - update available
  - watch started / stopped
- Renderer stack (top-right, below app bar):
  - max 3 visible, queue the rest; 6 s auto-dismiss, errors persist.
  - hover pauses timers; close button; optional action button (Open run,
    Settings, Retry).
  - `aria-live=polite` (assertive for errors).
- Dedupe by event ID so SSE + polling do not double-toast.
- Appearance setting: in-app toasts on/off; existing OS notifications remain a
  separate toggle.

## U2.5 Notification center (item 3, part 2)

- Bell in the app bar with unread count from the hub.
- Click opens a panel:
  - All / Unread filter, recent notifications from `/api/v1/notifications`.
  - Mark one/all read using the existing endpoints.
  - Click a row → open its run/route.
  - Empty and error states; retry.
- Tray and bell stay in sync; opening a notification from either marks it read.

**Exit gate:** upload scan shows live progress, a completion toast and Open run;
global drop works; bell count matches tray/dock; notification read actions are
reflected everywhere; tests added for job reducer, toast dedupe and the panel.

---

# Wave U3 — Run context and palette 2.0

## U3.1 Run context bar (item 7)

- Preload detects `?run=` in the hash; main fetches `GET /api/v1/runs/{id}` via
  the proxy (cached 60 s) and returns a compact context.
- Second slim bar under the app bar:
  `project · score · stage/date · [Copy link] [New window] [Findings] [Compare] [×]`
- Dynamic page offset: set a CSS variable and update the existing app bar offset
  styles; hidden when no run is in context or when dismissed for that run.
- Copy link produces `wombatpass://run/<id>`; Compare opens
  `#/diff?run=<id>`; Findings opens `#/findings?run=<id>`.
- Deep links and native tabs must show the correct context on every window.

## U3.2 Palette 2.0 (item 8)

- Prefix filters:
  - `>` actions/commands
  - `@` runs
  - `#` controls
  - `:` pages
  - `~` environments
  - plain text → current server search across all types
- Pass `types` to `/api/v1/search` to narrow server work.
- Recents:
  - Last 10 executed commands and last 5 searches, stored in `config.json`
    (not renderer localStorage) via `palette:recent`.
  - Shown on an empty query; clear button in Settings Advanced.
- New commands:
  - Switch environment, Sign in/out device, Manage devices, Scan clipboard/
    folder/watch, Stop watching, Toggle theme, Check updates, Open logs,
    Copy current run link.
- Accessibility: listbox semantics, active descendant, live result count.
- Execution allowlist extended in `main.js`; no arbitrary IPC from the palette.

## U3.3 Theme toggle

- Add “Appearance: system/light/dark” to Settings and a palette command.
- Applies to shell windows immediately; the dashboard keeps its own theme
  control (the app bar already inherits its variables).

**Exit gate:** run bar correct across navigation/deep links/tabs; palette works
with prefixes, recents and new commands; no arbitrary command can be executed;
existing palette search test extended and green.

---

# Wave U4 — Resilience and updates

## U4.1 Connection monitor and offline banner (item 10, part 1)

- Main health probe every 15 s (jittered), plus SSE state.
- Banner below the app bar when offline/degraded:
  `wombat-server unreachable · last sync 2m ago · [Retry] [Start Docker Stack] [Logs]`
- App bar dot turns amber/red; account chip shows “Unavailable”.
- Cached dashboard data stays visible; no blocking modal.
- On reconnect, toast “Connection restored” and refresh summary/state.

## U4.2 Crash page (item 10, part 2)

- New `crash.html` + preload. Replace the final `dialog.showErrorBox` path after
  three renderer crashes.
- Shows: what happened, correlation/log path, buttons Reload, Open logs,
  Copy diagnostics, Quit.
- Crash loop guard stays; safe mode option disables injected shell UI for one
  launch (`WOMBAT_SAFE_MODE=1`).

## U4.3 Diagnostics bundle (item 10, part 3)

- `src/diagnostics.js` collects: app/Electron versions, platform, active env
  (sanitized), health/SSE state, recent log tail, config keys — never tokens,
  CSRF secrets, passwords, or full config.
- Copy to clipboard or save a `.txt` from Help → Diagnostics and the crash page.
- Redaction unit test.

## U4.4 Update experience (item 9)

- Extend `updates.js` into a state machine:
  `idle → checking → available → downloading → ready | error`.
- Manifest may include `version`, `notes`, `url`, `sha256`, `size`.
- UI:
  - App bar/banner notice “Version X is available” with release notes.
  - Settings → Advanced shows current/latest, Check, Download.
  - Download with progress; verify SHA-256; then open the installer/DMG.
  - Confirm before opening; never install silently.
- Security: HTTPS only except localhost; reject redirects to other protocols;
  cap download size; checksum required if provided.
- No `electron-updater`/silent update until the app is Developer-ID signed and
  notarized (out of scope).

**Exit gate:** offline banner and reconnect toast; crash page reachable via a
forced renderer crash in a test; diagnostics contain no secrets; update flow
tested against a local manifest server.

---

# Wave U5 — Platform chrome, tabs, onboarding

## U5.1 Native window chrome (item 11)

- Productionize the U0 spike:
  - macOS `hiddenInset`, traffic-light padding, app bar drag region.
  - Windows `titleBarOverlay` (38 px), theme-aware overlay colors updated on
    theme change.
  - Linux standard frame.
- Settings → Appearance: “Use native window chrome” (default on where tested).
- Ensure `no-drag` on all buttons, chips, panels and scrollable areas.
- Full-screen and maximized behavior; multiple windows; Settings/palette keep
  their current frames.

## U5.2 Cross-platform tabs (item 12)

macOS already uses native tabs. For Windows/Linux, add an app-level tab model:

- `src/tabs.js` in main owns `{id, window, title, route, runId, hidden}`.
- Injected tab strip inside the app bar:
  `[Run A ×] [Run B ×] [+]`
- Background tabs stay alive as hidden BrowserWindows (state preserved); limit
  to 8 tabs and warn beyond that.
- Actions: new tab (`Ctrl/Cmd+T`), close (`Ctrl/Cmd+W`), switch
  (`Ctrl+Tab`/`Ctrl+Shift+Tab`), activate by click.
- Session restore: optionally reopen the last tabs on launch; setting in
  Appearance.
- macOS keeps native tabs and hides the custom strip; do not double-render.
- If the prototype causes memory or focus problems, fall back to a “Recent runs”
  switcher in the app bar and defer full tabs; decide at the U5 prototype gate.

## U5.3 Onboarding and What’s New (item 13)

- `src/onboarding.js` + injected dialog in the dashboard window:
  - Step 1: app bar / environment chip.
  - Step 2: Search `⌘⇧K`, prefixes and actions.
  - Step 3: Scan from the bar or drop a folder.
  - Step 4: device sign-in for remote environments.
  - Skip / Next / Done; stored in `config.json` as `onboardingVersion`.
- `src/whats-new.json`: version → bullets. After a version bump, show a
  dismissible “What’s new” panel once; Settings → Advanced can reopen it.
- Dialogs are focus-trapped, Esc-dismissible, theme-aware and translated.
- Do not show onboarding over a deep link/scan in progress; delay until idle.

## U5.4 Final polish

- Tray popover keyboard navigation and ARIA pass.
- Help/About content localization pass.
- Menu-bar icon theme verification.
- Full manual matrix and screenshots.

**Exit gate:** no overlap or dead zones in native chrome; tab behavior stable on
Windows/Linux code paths; onboarding/What’s New shown once and replayable; all
tests green; `1.0.0` package built and signed.

---

# Cross-cutting technical design

## State and IPC

- New channels, all allowlisted in `main.js`:
  - `shell:get-state`, `shell:state`
  - `shell:action` (`switch-environment`, `open-settings`, `scan:*`,
    `device:*`, `notification:*`, `theme:*`, `tabs:*`)
  - `shell:toast`, `shell:theme`, `shell:i18n`
- Renderers never receive tokens, CSRF values, full config, or raw device
  records. Device IPC returns metadata only.
- Renderer actions carry IDs, never arbitrary URLs or paths, except validated
  scan paths from `webUtils.getPathForFile`.

## Config schema additions

```json
{
  "preferences": {
    "theme": "system",
    "locale": "system",
    "density": "comfortable",
    "showToasts": true,
    "restoreTabs": false,
    "onboardingVersion": "0.12.0",
    "whatsNewSeen": "0.12.0"
  },
  "environments": [{ "id": "local", "name": "Local Docker", "url": "…", "kind": "local" }],
  "paletteRecents": { "commands": [], "searches": [] },
  "openTabs": []
}
```

Migration is additive; unknown keys are ignored. Tokens remain in the existing
`safeStorage`-encrypted `deviceAuth` map.

## Feature flags and rollback

- `WOMBAT_UI_TOASTS=0`, `WOMBAT_UI_TABS=0`, `WOMBAT_UI_NATIVE_CHROME=0`,
  `WOMBAT_SAFE_MODE=1` (disables injected shell UI for one launch).
- Settings → Advanced exposes the same toggles.
- Every wave ships behind its flag where the change is structural (native
  chrome, tabs); chrome additions are additive and default-on.

## Security review checklist

- No new `nodeIntegration`, no `<webview>`, sandbox stays on.
- CSP changes only widen `style-src` to `'self'`; no remote styles.
- External links still go through the navigation guard; update downloads are
  HTTPS/localhost only and checksum-verified.
- New IPC handlers validate types/lengths and reject unknown IDs.
- Toast/notification text rendered with `textContent`, never `innerHTML`.

---

# Test plan

## Unit / pure logic

- Config migration for `kind`, theme, recents, tabs.
- Scan job reducer (queued → running → done/failed/cancelled, retry rules).
- Update state machine and version comparison.
- Palette prefix parser and recent-item eviction.
- Diagnostics redaction (no token/password keys).
- i18n key parity.

## Electron E2E (Playwright-core)

Existing: `tests/smoke.mjs`, `tests/palette-search.mjs`,
`tests/device-auth.mjs`.

Add:

- `tests/ui-context.mjs` — context chip, environment switch, production badge,
  account menu, Settings tabs, device list/revoke.
- `tests/scan-center.mjs` — upload scan, panel progress, toast, Open run;
  global drop path via IPC/test hook; watch chip.
- `tests/notifications.mjs` — SSE event → toast; bell count; mark read sync.
- `tests/ui-resilience.mjs` — unreachable backend banner, forced renderer crash,
  diagnostics redaction, update manifest/download.
- `tests/tabs.mjs` — Windows/Linux tab model (platform-gated), session restore.
- `tests/a11y.mjs` — axe-core on Settings, palette, Help, dashboard overlay;
  keyboard-only flows.

## Manual matrix

- macOS (Intel/Apple Silicon), Windows 11, Ubuntu GNOME/KDE.
- Light/dark/high-contrast, en/de, 100%/125%/150% scaling.
- Narrow window (<1024 px), 8 tabs, offline/reconnect, minimized/start-minimized.
- Native chrome traffic lights/overlay, full screen, multiple monitors.

## Regression gates

Each wave: `npm run test:smoke`, `npm run test:palette`,
`npm run test:device`, the new wave test, `npm run sbom`, `npm run package:mac`.
Server regressions: `tests/test_device_auth.py`, `tests/test_search.py`,
`tests/test_scan_jobs.py` (unchanged behavior).

---

# File map (expected)

**New**

- `src/desktop-state.js` — state hub and broadcast
- `src/toasts.js` — notification/toast service
- `src/scan-state.js` — scan job reducer
- `src/run-context.js` — run metadata cache
- `src/tabs.js` — cross-platform tab model
- `src/diagnostics.js` — redacted diagnostics bundle
- `src/onboarding.js` — onboarding orchestration
- `src/whats-new.json`
- `src/shell-theme.css`
- `src/crash.html`, `src/crash-preload.cjs`
- `scripts/check-i18n.mjs`
- Tests listed above

**Modified**

- `src/main.js` — IPC, windows, settings API, flags, chrome
- `src/preload.cjs` — app bar, panels, run bar, toasts, tabs, onboarding
- `src/settings.html`, `src/settings-preload.cjs` — tabs, devices, appearance
- `src/palette.html`, `src/palette.js`, `src/palette-preload.cjs` — filters,
  recents, commands
- `src/tray.js` — state hub, auth/environment display
- `src/help.js`, `src/help.html`, `src/help-preload.cjs` — diagnostics copy
- `src/updates.js` — state machine and download
- `src/scan-folder.js`, `src/scan-zone.*` — job store and drop integration
- `src/config.js`, `src/i18n.js`, `src/server.js`, `src/security.js`
- `src/settings.html` / all shell HTML — theme link, CSP, ARIA
- `README.md`, `package.json`, `electron-builder.yml` if chrome/window options
  need packaging metadata

---

# Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dashboard DOM/CSS changes break the injected app bar | Shadow DOM, CSS-variable fallbacks, version detection, safe mode flag |
| IPC surface grows and becomes an attack path | Central allowlist, ID-only payloads, no URLs except validated opens, tests |
| State hub refactor destabilizes tray/widgets | Dual-write in U0; move consumers in U2 behind tests |
| Native chrome overlaps traffic lights or buttons | Platform-guarded options, drag/no-drag audit, screenshot tests, rollback flag |
| Custom tabs consume memory or lose focus | Limit 8, hidden-window model, prototype gate, recent-runs fallback |
| Toasts duplicate OS notifications | Separate toggles, event-ID dedupe, per-event policy |
| Theme/i18n regressions in dynamic text | Shared tokens, key-parity check, screenshot/manual matrix |
| Update download is abused | HTTPS/localhost, checksum, size cap, explicit confirm, no silent install |
| Accessibility work is postponed | U0 primitives + axe gate, not a final cleanup |

---

# Decisions and recommended defaults

1. **State hub, not duplicated polling.** Tray, app bar, toasts and settings all
   read `shell:state`; the tray migrates in U2.
2. **Shell theme follows the system/OS preference**, with an explicit override.
   The in-page app bar continues to inherit the dashboard’s variables.
3. **Environment kind is explicit**, never inferred from the URL. Defaults to
   `local`; existing environments migrate to `local`.
4. **In-app toasts are on by default**; OS notifications stay independently
   configurable.
5. **Native chrome is on for macOS/Windows after the spike**, Linux keeps the
   standard frame.
6. **Cross-platform tabs are prototyped with hidden windows.** If memory/focus
   is unacceptable, ship a “Recent runs” switcher instead and keep native tabs
   on macOS.
7. **Updates are download-and-open, not silent**, until the app is signed and
   notarized with a Developer ID.

---

# Definition of done

- App bar shows environment health, production state, auth and unread count.
- Scan jobs and notifications are visible from the bar and actionable.
- Settings is tabbed, with device listing/revocation.
- Run context and palette commands work without leaving the keyboard.
- Offline, crash, update and onboarding flows have no dead ends.
- Light/dark/high-contrast and en/de work across shell windows.
- Keyboard-only and axe-core checks pass.
- macOS package builds, signs and launches; Windows/Linux paths are guarded and
  documented.
- README and Help describe the new chrome and shortcuts.
