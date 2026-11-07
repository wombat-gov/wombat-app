# WOMBATpass Dashboard — macOS desktop app

Electron shell around the existing `wafpass-dashboard` build. The dashboard
itself is unchanged; this folder only wraps it for the desktop.

## How it works

```
BrowserWindow
  → http://127.0.0.1:47823
      ├── static server        serves build/dashboard (or ../wafpass-dashboard/dist)
      └── reverse proxy        /api, /health, /framework-update-info.yml
                                   → wombat-server (default http://127.0.0.1:8000)
```

Serving over `http://127.0.0.1` (not `file://`) and proxying the API keeps the
dashboard's HttpOnly cookie session and CSRF double-submit working exactly as
they do behind nginx in Docker. The fixed port keeps the origin stable across
restarts (cookies, localStorage, and the SSO allowlist depend on it).

## Requirements

- macOS (Apple Silicon or Intel), Node.js 22+ and npm
- Docker stack running (`docker compose up -d`) — wombat-server on port 8000

## First run

```bash
cd wombat-app
npm install
npm run dashboard:build   # builds wafpass-dashboard with an empty API base
npm start
```

On first launch the app opens **Server Settings**:

- URL defaults to `http://127.0.0.1:8000` (the docker-compose mapping)
- **Test connection** probes `/health` through the main process
- **Save** persists to `~/Library/Application Support/WOMBATpass Dashboard/config.json`
  and opens the dashboard immediately

Open the dialog again at any time with **⌘,** or **WOMBATpass Dashboard → Server
Settings…**. The proxy resolves the backend per request, so a change takes
effect without restarting the app.

## Rebuild after dashboard changes

```bash
npm run dashboard:build
```

This runs `npm run build` in `../wafpass-dashboard` with `VITE_API_URL=""`,
writes the bundle to `build/dashboard`, and strips sourcemaps. The Electron app
prefers `build/dashboard` and falls back to `../wafpass-dashboard/dist` when it
does not exist.

Serve the bundle without Electron (useful for debugging):

```bash
npm run serve        # http://127.0.0.1:47823
WOMBAT_SERVER_URL=http://127.0.0.1:8000 npm run serve
```

## Menu bar widgets

While the app is running, a wombat face sits in the macOS menu bar. Clicking it
opens a popover with two live widgets:

- **Service** — wombat-server health, URL, latency, last check, and the state of
  the WOMBAT Docker containers (server, postgres, keycloak, mcp, dashboard).
  The container list needs the `docker` CLI; it is auto-detected at
  `/usr/local/bin`, `/opt/homebrew/bin` and Docker.app, and can be overridden
  with `WOMBAT_DOCKER_BIN`.
- **Latest scan** — the most recent run: project, score /100, failed controls,
  pass rate, controls run, critical/high chips, and **Open run →** to jump
  straight to it in the dashboard.

The menu-bar icon gains a red dot when the server is unreachable, and the dock
shows the unread notification count (also visible as a badge in the popover;
click it to open the notifications page). The data refreshes when the popover
opens and every 15 seconds while visible; Docker and run details are cached for
60 seconds.

Right-click the menu bar icon for Open Dashboard, Show Widgets, Server
Settings…, Refresh and Quit. Closing the main window leaves the app running in
the menu bar (macOS convention); quit from the tray or ⌘Q.

Keyboard: **⌘⇧W** toggles the popover, **⌘⇧D** opens the dashboard from
anywhere.

API reads reuse the dashboard's persistent session and go through the app's
loopback proxy, so cookie auth works for local Docker and remote backends
without token handling.

## Environments

Server Settings manages named environments (`Local Docker`, `Staging`, …).
**Detect** probes `127.0.0.1:8000/8001/3000` and the Docker port mappings and
lists what it finds; click a result to fill the URL. The active environment is
used by the proxy and shown in the menu-bar tooltip; right-click the menu-bar
icon → **Environments** to switch without opening settings. The dashboard's own
`wombat_server_url` localStorage override is cleared on switch so the app stays
authoritative.

## Deep links

Register `wombatpass://` links and open them from CI comments, Slack or a PR:

| Link | Opens |
|---|---|
| `wombatpass://run/<id>` | dashboard for that run |
| `wombatpass://findings/<id>` | findings for that run |
| `wombatpass://notifications` | notifications |
| `wombatpass://waivers` | waivers |
| `wombatpass://show/<route>?run=<id>` | any dashboard route |

The scheme is registered in packaged builds. For development, either pass
`--open-run <id>` / `--open-route <route>` to a running instance, or set
`WOMBAT_REGISTER_PROTOCOL=1`. The popover's **Copy link** writes a
`wombatpass://run/<id>` link to the clipboard.

## Context-aware widgets

The widgets send `X-Mandant-Context` using the mandate selected in the
dashboard. The Latest scan card has a **project filter** (remembered across
launches), a score sparkline, a stale-scan chip after 24 h/7 days, and
**Findings** / **Copy link** actions next to **Open run**.

## Desktop-only tools

These exist only in the app because they use the clipboard, the OS or Docker:

- **Clipboard scan** — `⌘⇧S` sends Terraform/CloudFormation from the clipboard to
  `/api/v1/sandbox` and opens a result window: score, pass/fail/skip, failing
  controls, **Copy summary**, **Open in Dashboard**. Needs a signed-in session.
- **Command palette** — `⌘⇧K` searches runs, findings, controls, waivers,
  risks and projects through the server's ranked, mandate-scoped
  `/api/v1/search`, alongside local pages, environments and app actions.
  Older servers fall back to the local cache (200 runs / 500 controls).
  `↵` opens, `↑↓` navigate.
- **Stack console** — tray → **Stack Console**, or the popover **Stack** link:
  live CPU/memory per container, **Restart / Stop / Start**, and a streaming log
  viewer with follow, filter, pause and copy.
- **Scan an IaC folder** — `⌘⇧O`, tray → **Scan Folder…**, or drop a folder on
  the window (macOS also accepts a folder dropped on the dock icon). The app
  stages only IaC files (≤ 4000 files / 100 MB), `docker cp`s them into the
  running wombat-server container under `/app/.desktop-scans/<id>`, calls
  `/api/v1/scan` and cleans up — **no bind mounts**. **Watch Folder…** polls
  every 3 s and rescans after changes.
  - Deep link: `wombatpass://scan?path=<folder>`; CLI: `--scan-path <folder>`.
  - Needs the local Docker daemon and the wombat-server container. For a remote
    server, the planned upload endpoint is the appropriate path.
- **Native tabs / new window** — File → **New Window** (`⌘N`) or **New tab** in
  the popover. macOS groups them as native tabs; Windows/Linux get separate
  windows.
- **Print / PDF / drag link** — File → **Print…** (`⌘P`) and **Export Page as
  PDF…**; drag the `⠿` handle in the scan card to drop a
  `wombatpass://run/<id>` link into Finder, Slack, etc.

Shortcuts: `⌘⇧W` widgets · `⌘⇧D` dashboard · `⌘⇧S` clipboard scan · `⌘⇧K`
palette · `⌘⇧O` scan folder · `⌘N` new window. On Windows/Linux use `Ctrl`.

## Cross-platform notes

Core features use Electron APIs, Node and the Docker CLI, so they port to
Windows/Linux. Platform-specific extras:

- **macOS only:** dock icon toggle, menu-bar text, dropping a folder on the dock
  icon, native window tabs. Finder Quick Action (optional): Automator → New
  Quick Action → input *Folders* in *Finder* → Run Shell Script (pass input as
  arguments):
  ```bash
  for f in "$@"; do
    open "wombatpass://scan?path=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$f")"
  done
  ```
- **Windows/Linux:** the tray menu, popover, drop zone, command palette and deep
  links work; use `--scan-path` or the drop zone for folders. Native tabs fall
  back to separate windows.
- The Docker CLI is resolved from `PATH` plus common install locations;
  override with `WOMBAT_DOCKER_BIN`.

## App bar & Help

Every dashboard window (main window and native tabs) gets a slim app bar above
the dashboard, injected by the preload — the dashboard build is unchanged. It
contains:

- **Dashboard · Findings · Catalogue · Runs · Evidence · Waivers · Compliance**
  (navigation preserves the currently selected run and highlights the active page)
- **Search** (`⌘⇧K`, opens the command palette — all pages and actions)
- **Scan** (folder scan / drop zone), **Stack** (stack console), **Help**

The bar uses the dashboard's theme variables, so it follows light/dark mode.
An empty `#/?run=…` route restored by the dashboard is normalized to
`#/dashboard?run=…` so the page never opens blank.

**Help & About** (app bar, Help menu, tray, or the palette) has four tabs:

- **About** — app/Electron/Chromium/Node versions, active environment, server
  health, documentation links.
- **Shortcuts** — every global and app shortcut.
- **SBOM** — direct runtime components with versions and licenses, filterable,
  plus **Save SBOM (CycloneDX)**. Generated by `npm run sbom` from the Electron
  runtime and the dashboard's production dependencies (build/test tooling is
  excluded and noted in the view).
- **Diagnostics** — config/log paths, platform, preferences, **Copy
  diagnostics**, show logs, open the config folder.

## Live server integration (Wave A)

When the server provides it, the app uses two new endpoints:

- **`GET /api/v1/desktop/summary`** — one call for the popover: latest run with
  failed controls, critical/high counts, pass rate and controls, trend,
  projects, unread notifications, governance expiry and the 24 h digest.
  Older servers (404/501) automatically use the previous multi-call path.
- **`GET /api/v1/events`** — Server-Sent Events for `run.created`,
  `notification.created` / `notification.updated`, `waiver.changed`,
  `risk.changed` and `scan.completed`. One stream is kept open in the main
  process through the loopback proxy, with exponential backoff, a 45 s
  heartbeat watchdog and `Last-Event-ID` replay. Live events refresh the tray,
  dock badge and popover immediately; the 60 s poll remains as a safety net.

Server settings: `WOMBAT_EVENTS_ENABLED` (default `true`) and
`WOMBAT_EVENT_BUFFER` (default `500`). The dashboard nginx config includes a
buffering-free `/api/v1/events` location for future web clients.

## Asynchronous scans (Wave B)

Wave B adds server-side scan jobs and IaC archive uploads:

- `POST /api/v1/scans` queues a server path; `POST /api/v1/scans/upload` accepts
  a `.zip` / `.tar.gz` (50 MB compressed, 200 MB extracted, 5,000 files, IaC
  extensions only); `GET /api/v1/scans/{id}` returns status/progress/run;
  `POST /api/v1/scans/{id}/cancel` cancels a queued job.
- The in-process worker runs the engine off the event loop, publishes
  `scan.progress` on the SSE stream, persists the run and cleans up uploads.
- The desktop app uploads staged IaC (tar.gz) and shows progress/cancel in the
  drop zone. Folder scans no longer need Docker when the server supports Wave B;
  the `docker cp` path remains as a fallback for older servers.
- Server settings: `WOMBAT_SCAN_JOBS_ENABLED`, `WOMBAT_SCAN_JOB_POLL_SECONDS`,
  `WOMBAT_SCAN_UPLOAD_MAX_MB`, `WOMBAT_SCAN_UPLOAD_MAX_EXTRACTED_MB`,
  `WOMBAT_SCAN_UPLOAD_MAX_FILES`.
- macOS AppleDouble metadata (`._*`) is rejected server-side and suppressed in
  the app's tar (`COPYFILE_DISABLE=1`).

## Desktop device sign-in (Wave D)

Remote and SSO deployments can authenticate the app without relying on loopback
browser cookies:

1. Server Settings → **Desktop sign-in** → **Sign in with browser**. The app
   starts a device authorization and opens the browser approval page.
2. Sign in to the dashboard in that browser (local password or SSO) and approve
   the displayed code. `WOMBAT_PUBLIC_URL` / `WOMBAT_DASHBOARD_URL` decide which
   origin the page and login link use.
3. The app exchanges the approved code for an opaque `wombat_dev_…` token, stores
   it encrypted with the OS keychain (`safeStorage`), and injects
   `Authorization: Bearer …` into its loopback proxy for the active environment.
   The dashboard then works normally, including SSE, scans and the palette.
4. **Sign out** revokes the device server-side (`DELETE /auth/devices/{id}`) and
   removes the local token. Tokens are per environment and survive restarts.

Server settings: `WOMBAT_DEVICE_AUTH_ENABLED` (default true),
`WOMBAT_DEVICE_CODE_TTL_SECONDS` (600), `WOMBAT_DEVICE_POLL_INTERVAL` (5),
`WOMBAT_DASHBOARD_URL`. No plaintext token is ever written to `config.json`.

## Shell foundations (Wave U0)

- **State hub** — the main process publishes environment/health/auth/connection,
  unread count and scan/update state to every window as display-only snapshots
  (`shell:state`). Tokens never leave the main process.
- **Theme** — Settings, palette, Help, scan zone, logs, stack console and the
  tray popover share light/dark/high-contrast tokens and honour reduced motion.
  The in-page app bar keeps inheriting the dashboard's own variables.
- **Locale** — the shell follows the OS locale by default, with live en/de
  switching for the app bar, Settings and palette.
- **Accessibility** — app bar has `aria-current` and roving-tabindex arrow
  navigation; the palette is a proper combobox/listbox with an active
  descendant and live result count; axe-core gates Settings, palette and Help.
- **Native chrome (spike)** — macOS uses `hiddenInset` and the app bar becomes
  the drag region; Windows uses `titleBarOverlay`; Linux keeps the standard
  frame. Disable with `WOMBAT_NATIVE_CHROME=0`. See `UI-NATIVE-CHROME.md`.
- **Context & account chips (U1)** — the app bar shows the active environment
  with a health dot and `PROD` badge, plus the signed-in account/device. Both
  open native menus for switching environments, testing the connection,
  opening logs/settings, signing in with the browser, and managing/signing out
  devices. Production environments use red/amber confirmation states.
- **Tabbed Settings (U1)** — Connection, Sign-in & devices, Appearance, Scans
  and Advanced. The device view lists authorized devices with created/last-used
  timestamps and revokes tokens; theme and language can be changed live.
- **Scan center (U2)** — the Scan split button opens a job drawer with
  clipboard/folder/watch actions, active progress, recent jobs, cancel,
  Open run and Scan again. Dropping an IaC folder anywhere on the dashboard
  starts a scan; a compact chip shows watch mode.
- **Toasts and notification center (U2)** — scan results, device sign-in,
  connection changes, notifications and update notices surface as in-app
  toasts (toggle in Appearance). The bell lists notifications with All/Unread
  filters, Mark all read and deep links; non-admin users get a clear admin-only
  message.
- **Scan jobs store (U2)** — `/api/v1/scans` is polled while the panel is open
  and updated from `scan.progress` / `scan.failed` / `scan.completed` SSE
  events, capped at the 20 most recent jobs.
- **Run context bar (U3)** — opening a run adds a slim bar with project,
  score, stage/branch/date, Copy link, New window, Findings, Compare and a
  dismiss button. It follows deep links and every native tab independently.
- **Palette 2.0 (U3)** — prefixes `>` commands, `@` runs, `#` controls,
  `:` pages and `~` environments; recent commands/searches; shell commands
  for devices, theme, connection refresh and notifications. Recents live in
  `config.json` and can be cleared from Settings → Advanced.
- **Offline/crash UX (U4)** — a persistent banner shows unreachable/degraded
  state with last sync, Retry, Start stack and Logs. A fresh crash window
  offers Reload, Reload in safe mode, logs and a redacted diagnostics bundle;
  `WOMBAT_CRASH_RETRY_LIMIT` controls reload attempts.
- **Diagnostics (U4)** — Help and the crash page copy/save a redacted JSON
  bundle (environment, health, auth method, preferences, log tail) with no
  tokens, cookies or password hashes.
- **Updates (U4)** — Settings → Advanced and the app-bar update chip use a
  check → available → downloading → ready state machine. Downloads are
  HTTPS/localhost-only, size-capped, SHA-256 verified, and opened only after
  explicit confirmation (`updates:check/download/open`).
- **Native chrome + tabs (U5)** — Appearance can disable native window chrome
  (restart required). On Windows/Linux an injected tab strip keeps background
  tabs alive as hidden windows, with Ctrl/Cmd+T/W/Tab, a + button and optional
  session restore; macOS keeps native tabs. `WOMBAT_UI_TABS=0/1` overrides.
- **Onboarding / What’s New (U5)** — a four-step first-run tour covers the
  app bar, palette prefixes, scanning and recovery. After version changes a
  What’s New panel appears once; both can be replayed from Settings → Advanced.
- **Production hardening (U6)** — 401 detection with a re-auth banner,
  browser-session listing/revocation, per-user notifications with deep links
  and pagination, system notification status, Do Not Disturb, localized
  Help/crash pages, app-bar/tab/onboarding accessibility audits, Windows
  overlay theme sync, platform packaging CI, visual baselines and startup/
  palette performance budgets (`test:auth`, `test:i18n`, `test:perf`,
  `test:visual`).
- **Operational polish (U7)** — Settings Apply/Revert, dirty guard, test-all,
  production/delete confirmations and restart banner; tab drag/arrow reorder,
  active restore, duplicate detection, context actions and per-tab crash
  recovery; server scan retry/filters/pagination/cancel-all; update channels,
  auto-check, snooze and show-in-folder; clipboard consent, sign-out-all,
  clear-local-data, diagnostics preview, external-link confirmation, health
  backoff, safe-mode badge, dock/jump-list/taskbar integration.
- **Refinement (U8)** — undo closed tabs, palette match highlighting and
  pinned favorites, Help release notes/licences/search/support bundle/last
  crash, `?` shortcut to Help → Shortcuts, dashboard zoom, optional local
  crash reports and diagnostics process metrics.

## Desktop behaviour

- **Window state** — size, position and maximized state are restored on the
  next launch (saved in `config.json`, validated against the current displays).
- **Launch at login** and **Start in menu bar (no window)** are toggles in
  Server Settings. The second one turns the app into a menu-bar-only companion
  until you open the dashboard.
- **Notifications** — when a new scan with critical/high findings appears, a
  native macOS notification is shown (click it to open the run). **Governance
  reminders** notify once a day about waivers/risk acceptances expiring within
  7 days and include a daily scan digest. Both are configurable in Server
  Settings; the first scan seen after launch is the baseline.
- **Menu bar text** — optionally show the latest score or the unread count next
  to the wombat icon.
- **Show in Dock** — uncheck it for a true menu-bar-only app.
- **Start Docker Stack** — set the Docker Compose directory under Integrations;
  the tray menu (and the popover when the server is down) can run
  `docker compose up -d` and wait for `/health`.
- **Check for Updates** — set an update feed URL (JSON manifest with
  `version`, `url`, optional `notes`) and use **WOMBATpass Dashboard → Check for
  Updates…**; it opens the download link when a newer version exists.
- **Logs** — `~/Library/Logs/WOMBATpass Dashboard/main.log` (rotated at 2 MB).
  Open it from **Help → Show Logs** or the settings window. Renderer crashes are
  logged and the window reloads up to three times.
- **Backend down at startup** — a native dialog offers Retry, Server Settings,
  Open Anyway or Quit instead of leaving the dashboard in an error state.
- **Shell language** — English/German, following the system locale. The
  dashboard's own language is independent.

Development aids:

```bash
# open the popover on launch (for screenshots / UI work)
WOMBAT_POPOVER_DEMO=1 npm start

# run a second instance next to an installed one
WOMBAT_PORT=47825 npx electron . --user-data-dir=/tmp/wombat-dev

# open a specific window on launch (QA)
WOMBAT_OPEN=palette    # or stack | dropzone | quickscan | tab

# smoke test (needs build/dashboard + a reachable wombat-server)
npm run test:smoke

# palette search against the live server (admin/admin by default)
npm run test:palette

# device authorization end to end (sign-in, encrypted storage, revocation)
npm run test:device

# UI foundations (state, theme, i18n, app bar/palette accessibility)
npm run test:ui
npm run test:a11y
npm run check:i18n

# scan center, drop overlay, toasts and notification center
npm run test:scan
npm run test:scan-state

# run context bar
npm run test:run

# offline/crash/diagnostics and updates
npm run test:crash
npm run test:update

# onboarding and cross-platform tabs
npm run test:onboarding
npm run test:tabs

# U6 production hardening
npm run test:auth
npm run test:i18n
npm run test:perf
npm run test:visual

# U7 operational polish
npm run test:settings

# U8 refinement is covered by test:palette, test:a11y, test:crash and test:visual
```

## Package desktop apps

The same codebase produces macOS, Windows and Linux builds:

```bash
npm run package:mac     # DMG + ZIP
npm run package:win     # NSIS installer + ZIP
npm run package:linux   # AppImage + DEB
```

Each command rebuilds the dashboard bundle and SBOM, then runs electron-builder
for that platform. Expected artifacts:

```
release/WOMBATpass Dashboard-1.0.0-arm64.dmg
release/WOMBATpass Dashboard-1.0.0-arm64.zip
release/WOMBATpass Dashboard-1.0.0-x64.exe
release/WOMBATpass Dashboard-1.0.0-x64.zip
release/WOMBATpass Dashboard-1.0.0-x86_64.AppImage
release/WOMBATpass Dashboard-1.0.0-amd64.deb
```

GitHub Actions runs the static checks on Ubuntu and builds all three platforms
with `.github/workflows/desktop.yml`, uploading the installers as artifacts.

Icons and installer assets are generated locally with `npm run assets` and
committed under `build/` and `src/assets/`. Windows uses `build/icon.ico`,
Linux uses `build/icon.png`, macOS uses `build/icon.icns` and the DMG
background. `npm run assets` requires macOS tooling (headless Chrome, `sips`,
`iconutil`); CI does not regenerate them.

The DMG window uses the WOMBAT airfield artwork
(`wafpass-dashboard/public/flight-map-bg.png`) as its background, with the app
and `/Applications` icons positioned over it and a drag hint. Assets are
generated by `npm run assets`:

- `npm run icon` — composes the high-resolution waving mascot
  (`waf2p.github.io/images/brand/mascot/full/wombat-wave.png`) into an
  Apple-style rounded tile and writes `build/icon.icns`, `build/icon.png` and
  `build/icon.ico`.
- `npm run dmg:background` — renders `build/background.png` (540×380) and
  `build/background@2x.png` (1080×760); dmg-builder merges them into a Retina
  TIFF.
- `npm run tray:icons` — writes the normal and alert menu-bar icons from the
  wombat face to `src/assets/`.
- `npm run sbom` — writes `src/sbom.json` (Help overview) and
  `build/sbom.cdx.json` (CycloneDX, shipped as `Contents/Resources/sbom.cdx.json`).

Both use headless Chrome for layout/typography (set `CHROME_BIN` if Chrome is
not in `/Applications`).

Open the DMG and drag the app to `/Applications`. The build targets the host
architecture (arm64 on Apple Silicon; run `electron-builder --mac --x64` for
Intel).

- The macOS app is **ad-hoc signed** (`codesign --sign -` via
  `scripts/after-pack.cjs`) with no Developer ID and no notarization. Apps built
  on this machine launch normally. If the DMG is downloaded elsewhere, macOS asks
  the recipient to right-click → Open, or `xattr -dr com.apple.quarantine` the
  app.
- The Windows installer is unsigned: SmartScreen shows an “Unknown publisher”
  warning until a code-signing certificate is configured.
- The Linux AppImage is portable; the DEB installs the app under `/opt` and
  registers a desktop entry.
- **Notarization is scaffolded** in `scripts/notarize.cjs` (electron-builder
  `afterSign`). Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`, remove `mac.identity: null` (or set `CSC_NAME` to your
  Developer ID), and `npm run package:mac` will sign and notarize.
- The dashboard bundle is shipped as `Contents/Resources/dashboard`; the app
  code lives in `app.asar`; menu-bar icons live in `Contents/Resources/assets`.
- Artifacts are written to `release/`, which is git-ignored.

## Status

- [x] Phase 1: loopback static server, sandboxed window, menu, single instance
- [x] Phase 2: streaming `/api` reverse proxy + in-app Server Settings
- [x] Phase 3: navigation guard, permission policy, downloads, persistent session
- [x] Phase 4: `electron-builder` DMG/ZIP packaging, icon, ad-hoc signing
- [x] Phase 5: macOS menu-bar popover with Service and Latest-scan widgets
- [x] Phase 6: logging, crash recovery, window state, login item, dock badge,
      status icon, notifications, global shortcuts, smoke test, shell i18n
- [x] Phase 7: environments + detection, deep links, context-aware widgets,
      project filter, sparkline, dock/menu-bar options, updates, governance
      reminders, Docker stack start
- [x] Phase 8: clipboard scan, command palette, stack console + logs, folder
      scan/watch without mounts, native tabs, print/PDF/drag link
- [x] Phase 9: in-window app bar, Help & About with shortcuts, diagnostics and
      SBOM overview/export
- [x] Phase 10 (backend Wave A): desktop summary endpoint + SSE live updates,
      feature-detected with fallbacks
- [x] Phase 11 (backend Wave B): async scan jobs, archive upload, progress and
      cancel, with the Docker path retained as fallback
- [x] Phase 12 (backend Wave C): global search endpoint (`pg_trgm` indexes,
      migration 0058) and server-ranked command-palette results with a local
      fallback for older servers
- [x] Phase 13 (backend Wave D): browser-approved device authorization
      (migration 0059), revocable hashed device tokens, encrypted per-environment
      storage, proxy Bearer injection and Settings sign-in/sign-out
- [x] Phase 14 (UI Wave U0): desktop state hub, shared shell theme (light/dark/
      high contrast/reduced motion), live en/de locale switching, app-bar and
      palette accessibility, native window chrome spike
- [x] Phase 15 (UI Wave U1): environment kinds and production guardrails,
      app-bar context/account chips and native menus, tabbed Settings,
      authorized-device list/revoke, live theme/language controls, tray parity
- [x] Phase 16 (UI Wave U2): scan job store and scan center drawer, global
      IaC drop target, watch chip, in-app toast host, notification center
      with read actions, scan/notification SSE integration, toast preference
- [x] Phase 17 (UI Wave U3): run context bar with copy/new-window/findings/
      compare actions, palette prefix filters, recent commands/searches,
      shell commands, theme commands and clear-history control
- [x] Phase 18 (UI Wave U4): offline banner with retry/stack/logs, crash
      window with safe mode, redacted diagnostics in Help/crash page,
      update state machine with checksum-verified download and Settings UI
- [x] Phase 19 (UI Wave U5): native-chrome preference, cross-platform tab
      strip with restore, first-run tour and replayable What's New
- [x] Phase 20 (UI Wave U6): notification parity migration/API, auth lifecycle
      and session management, DND/system notification controls, full shell
      localization + pseudo-locale gate, expanded accessibility audits,
      visual/performance gates and three-platform packaging CI
- [x] Phase 21 (UI Wave U7): Apply/Revert Settings, tab reorder/active restore/
      context actions, scan retry/filter/pagination/cancel-all, update
      channels/snooze, resilience/privacy UX and OS integration
- [x] Phase 22 (UI Wave U8): tab-close undo, palette highlighting/favorites,
      release notes/licenses/searchable Help/support bundle, ? shortcut,
      zoom control and local crash reports — 1.0.0

## Security behaviour

- **Session:** a private `persist:wombat` partition — cookies and localStorage
  survive restarts and never mix with other Electron apps. Cookies are flushed
  on quit, so quitting right after login keeps you signed in.
- **Navigation:** in-app navigation is limited to the app origin, loopback hosts
  (Docker backend, local Keycloak) and the configured backend. Everything else
  (http/https) opens in the default browser; `file:` and other schemes are
  blocked. Remote SSO/IdP hosts can be allowlisted with
  `WOMBAT_ALLOWED_NAV_HOSTS=idp.example.com,login.microsoftonline.com` or
  `"allowedNavigationHosts": ["…"]` in `config.json`.
- **Permissions:** camera, microphone, geolocation, notifications, etc. are
  denied. Clipboard read/write is granted only to the app origin (needed by the
  dashboard's copy buttons); fullscreen is allowed for the map controls.
- **Downloads:** the session shows a native save dialog (defaulting to
  `~/Downloads`) and logs the result.
- **Renderer:** `contextIsolation`, `sandbox`, no Node integration, no
  `<webview>`; the preload exposes only version information.

## Notes

- Precedence for the backend URL: saved setting → `WOMBAT_SERVER_URL` env →
  `http://127.0.0.1:8000`.
- The maplibre worker is copied into the bundle at build time
  (`build/dashboard/assets/maplibre/`) and the CDN URL is rewritten, so the map
  no longer loads a third-party script. Map tiles still need network access.
- Verified end-to-end against the Docker stack: settings test → save → login →
  dashboard data through the proxy, with cookies issued on the app origin.
- The dashboard top bar is slightly too wide for a 1440 px viewport (nav items
  start off-screen). This reproduces in the Docker dashboard at the same width,
  so it is a dashboard layout issue, not an Electron one. The app bar above it
  provides the primary navigation; the dashboard's own nav keeps its
  role/run/mandate controls. Widening the window on a larger display avoids it.
- True Notification Center/desktop widgets (WidgetKit) are not part of this
  shell; they need a signed Swift extension and App Group. The menu-bar popover
  is the lightweight equivalent.
