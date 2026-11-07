# UI hardening plan — U6, U7, U8

> **Status (2026-11-07):** U6, U7 and U8 are implemented (app `1.0.0`).
> Baseline before U6: `0.16.0`; U0–U5 are complete.

## Goal

U0–U5 made the shell feature-complete. U6–U8 make it **boring in the good
way**: predictable across platforms, recoverable when auth or the backend
fails, fully keyboard/screen-reader usable, fully translated, and backed by
CI instead of manual confidence.

The work is split into three shippable programs:

| Program | Scope | Version | Estimate |
|---|---|---|---|
| **U6 — Production hardening** | P0: platform CI, auth lifecycle, notification parity, accessibility, i18n, visual/perf gates | `0.17.0` | 10–14 d |
| **U7 — Operational polish** | P1: Settings semantics, tab robustness, scan/update operations, resilience, privacy, OS integration | `0.18.0` | 9–13 d |
| **U8 — Refinement** | P2: UI details, help/release notes, crash reporting maturity | `1.0.0` | 4–6 d |

Total: roughly 23–33 dev-days, excluding external Windows/Linux QA and Apple
signing/notarization.

## Principles

1. **No new surface without an owner.** Every new banner, dialog or panel has
   a state source in the main process and a test.
2. **Platform confidence is a gate, not a follow-up.** A feature is not done
   until it has been exercised on the platforms it claims to support.
3. **Recoverability beats polish.** Auth expiry, backend loss, tab crashes and
   update failures must never leave a dead end.
4. **Server contracts stay explicit.** Notification parity, scan retry and
   session management are identified as server work, not hidden in the app.
5. **Shell-only localization.** The dashboard keeps its own i18n; the shell
   completes en/de (and a pseudo-locale) for every string it owns.
6. **Screenshots and axe are part of CI.** Manual visual checks remain, but
   regressions should fail a gate.

---

# U6 — Production hardening (P0)

## U6.1 Platform confidence and native chrome

Covers P0-1 and the Windows overlay part of P0-6.

### Scope

- **Windows/Linux CI**
  - GitHub Actions matrix: `macos-14`, `windows-2022`, `ubuntu-22.04`.
  - Run smoke, settings/tabs, palette, device, scan, onboarding and a11y tests.
  - Ubuntu uses `xvfb-run`; tray/popover tests are skipped if no system tray.
  - Persist logs, screenshots and crash artifacts on failure.
- **Windows title-bar overlay**
  - Update `titleBarOverlay` colors when the dashboard theme or system theme
    changes (`win.setTitleBarOverlay`).
  - Preload reports the dashboard's effective theme (`shell:dashboard-theme`).
  - Fall back to `nativeTheme.shouldUseDarkColors` when the dashboard has no
    theme.
- **Linux tray**
  - Verify AppIndicator availability and fallback behavior.
  - Document missing-tray environments; keep the app usable without a tray.
- **Window matrix**
  - 100 / 125 / 150% scaling, multi-monitor, fullscreen, maximized, narrow
    window (<1024 px), and light/dark/high-contrast.
- **Menu-bar icon**
  - Audit the coloured tray icons in light/dark menu bars. Either make a
    template variant or document why the colour asset is intentional.

### Tests / gate

- CI green on all three runners.
- Manual Windows/Linux checklist completed and attached to the release.
- Overlay colors switch in both themes without restart.
- No app-bar/traffic-light/overlay overlap at any tested scale.

## U6.2 Auth and session lifecycle

Covers P0-2.

### Scope

- **401 / expired-session awareness**
  - Main-process proxy observes 401 responses and emits `auth:expired`.
  - Preload shows a persistent banner: “Session expired / Sign in again” with
    the current environment.
  - Re-auth preserves the current route and run; after sign-in, reload only
    the affected tab.
- **Device-token lifecycle**
  - Show device status, last used, and revoked state (already available).
  - Optional expiry policy (decision below); surface “expires in N days” if
    the server provides an expiry.
  - Revoked/invalid token → banner + one-click browser sign-in.
- **Browser sessions**
  - Reuse existing server endpoints:
    `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/{id}`,
    `DELETE /api/v1/auth/sessions`.
  - Settings → Sign-in & devices gains a **Browser sessions** section:
    device, user agent, IP hash, created/last seen, current session, revoke.
  - “Sign out all sessions” with production confirmation.
- **Environment-aware auth**
  - Each environment shows its own auth method/status in Settings and the
    account menu.
  - Switching environments must not show another environment's user as
    signed in.
- **Post-login continuity**
  - Remember a pending run/tab route across sign-in.
  - Do not lose unsaved scan context when a session expires.

### Server work

- Confirm session endpoints cover self-service list/revoke (they exist today).
- Device tokens: current tokens do not expire. Add an optional `expires_at`
  only if the expiry decision below is accepted (migration + tests).
- Add explicit 401 reason codes if the UI needs to distinguish “expired” from
  “revoked” (optional).

### Tests / gate

- Simulate 401 by expiring the access cookie; banner appears and re-auth
  restores the run.
- Revoke the current device; app falls back to sign-in without losing the tab.
- Non-admin user lists only their own sessions.
- Sign out all invalidates every session and returns the UI to sign-in.

## U6.3 Notification parity and permissions

Covers P0-3.

### Problem

`GET /api/v1/notifications` is admin-only today. The bell therefore works for
admins and shows an admin-only message for everyone else. Notifications also
have no link metadata, so clicking can only open the generic page.

### Server work

- Migration 0060 (next server revision):
  - `notifications.target_user_id` (nullable FK users).
  - `notifications.link_route`, `link_run_id`, `link_url`, `project`.
  - Indexes on `(target_user_id, is_read, created_at)`.
- Permission model:
  - A user can list/mark-read their own notifications plus notifications
    targeted at their role/audience.
  - Admin retains “see all”.
  - Creation accepts `target_user_id` or `target_role`; validate at least one.
- List endpoint: pagination/cursor, `unread_only`, `category`, `limit`.
- Tests: user isolation, role audience, admin visibility, mark-read scope,
  link metadata round-trip.

### App work

- Bell visible for all users; unread count from the server/summary.
- Notification rows deep-link via `link_route` / `link_run_id`; fall back to
  the notifications page.
- Category filters, pagination/load more, per-category notification
  preferences (findings/governance/system).
- OS permission status:
  - Detect `Notification.permission`; explain when OS notifications are
    blocked and offer a shortcut to system settings.
- Quiet hours / Do Not Disturb:
  - Local preference; suppress OS notifications (not in-app toasts) during a
    configured window.
- Toast history:
  - Keep the last N in-app toasts in memory so a missed toast can be reviewed
    from the bell panel.
- Tray/dock/bell unread counts remain one source of truth.

### Tests / gate

- Non-admin sees their notifications and cannot see another user's.
- Clicking a notification opens the linked run/route.
- Mark one/all read updates bell, dock and tray.
- DND suppresses OS notifications while in-app toasts still appear.
- Admin still sees all notifications.

## U6.4 Accessibility completion

Covers P0-4.

### Scope

- **Tab strip**
  - `role=tablist`, `role=tab`, `aria-selected`, `aria-controls`; arrow-key
    roving focus; close buttons labelled; focus moves to the activated tab
    and back to the next tab after close.
- **Onboarding**
  - Focus trap (already present), initial focus, return focus on close,
    `aria-live` step announcements, Esc = skip.
- **Crash page**
  - Focus the primary action; announce status changes; keyboard-only copy/save.
- **Tray popover**
  - Roving focus across actions, Esc closes and returns focus to the tray
    button (where the OS supports it), screen-reader labels for icon buttons.
- **Offline/update/run bars**
  - `role=status`/`aria-live` for connection changes; update chip has a clear
    accessible name and state.
- **App bar shadow root**
  - Add an axe audit path for the shadow DOM app bar (CSP-safe injection via
    the main process or a dedicated test preload).
- **Focus and motion**
  - Restore focus after route changes and tab switches.
  - Respect `prefers-reduced-motion`; verify high-contrast tokens.
- **Screen-reader scripts**
  - VoiceOver (macOS), Narrator (Windows), Orca (Linux) smoke checklists.

### Tests / gate

- axe: no critical/serious issues in Settings (all tabs), palette, Help, crash
  page, onboarding and the app-bar overlay.
- Keyboard-only run: launch → settings → sign in → scan → palette → tabs →
  offline/reconnect → crash page.
- Reduced-motion and high-contrast visual checks.

## U6.5 Localization completion

Covers P0-5.

### Scope

- Move every shell-owned string into `src/i18n.js`:
  - main-process action labels (palette command labels), tray menu, toasts,
    run-bar dynamic strings, crash page, update UI/status, diagnostics labels,
    offline banner, tab strip, onboarding, settings validation.
- Help/About body content: headings, labels and paragraphs (links can remain
  external).
- Date/time/number formatting via `Intl.DateTimeFormat` and
  `Intl.NumberFormat` with the selected locale.
- Add a pseudo-locale (`en-XA`) test mode that transforms strings; fail the
  build if raw keys or English literals leak into the shell.
- Runtime locale switch updates every open shell window, menu labels, and
  menu-bar tooltip; open windows do not require a restart.
- Document that the dashboard's own language remains independent.

### Tests / gate

- `npm run check:i18n`: key parity, no duplicates, no raw-key usage in HTML.
- Pseudo-locale E2E: app bar, palette, Settings, toasts, run bar, crash page.
- en/de visual smoke of every shell window.

## U6.6 Visual and performance gate

Covers P0-6.

### Scope

- **Screenshot regression**
  - Playwright screenshots per platform (macOS/Windows/Linux), per theme
    (light/dark/high-contrast), for dashboard + app bar, Settings tabs,
    palette, tray popover, scan panel, onboarding and crash page.
  - Store platform-specific baselines; never compare across OSes.
  - Upload diffs as CI artifacts.
- **Performance budgets**
  - Cold start to first dashboard paint: ≤ 3 s on CI.
  - Palette open/first results: ≤ 200 ms.
  - Tab activate: ≤ 300 ms.
  - Renderer memory per tab: warn above ~250 MB via `app.getAppMetrics()`.
  - Large lists: virtualize palette results, scan jobs and notifications when
    above 100 rows.
- **Instrumentation**
  - `performance.mark` at app-ready, window-ready, dashboard-paint, palette-open,
    tab-activate; log durations to main log and CI report.
- **Error-rate checks**
  - CI fails on unhandled main/renderer errors, rejected IPC or console errors
    in the shell windows.

### Tests / gate

- Screenshot suite passes with an agreed diff threshold.
- Performance budgets pass on the Windows CI runner and macOS.
- Memory warning appears when tabs exceed the budget.

---

# U7 — Operational polish (Tier 1)

## U7.1 Settings semantics and tab robustness

Covers P1-7 and P1-8.

### Settings

- Dirty-state model for every tab; **Apply / Revert** instead of implicit save.
- Theme/locale preview can be reverted on Cancel; persist only on Apply.
- Native-chrome change shows a restart banner with **Relaunch now**.
- Unsaved-changes guard when closing or switching environments.
- Confirm environment deletion and changing an environment to production.
- Add “Test all environments” with per-environment results.
- Show per-environment auth/device status in the environment selector.

### Tabs

- Pointer drag reorder; arrow-key reorder; persist order.
- Overflow scroll with active tab scrolled into view; overflow menu.
- Restore the active tab (not the last created tab).
- Duplicate detection: activating an existing run tab instead of creating a
  duplicate (with a “open duplicate” escape hatch).
- Tab context menu: Close, Close others, Close to the right, Duplicate.
- Memory warning at 6 tabs and a hard cap at 8; offer “Close inactive tabs”.
- Per-tab crash recovery: a crashed hidden tab shows its own crash state
  without taking down the active tab.

### Tests / gate

- Apply/Revert leaves config unchanged on Cancel.
- Native-chrome restart banner appears and relaunch preserves tabs.
- Drag/arrow reorder and active restore survive relaunch.
- Duplicate detection and tab context actions.

## U7.2 Scan and update operations

Covers P1-9 and P1-10.

### Scans

- Server: `POST /api/v1/scans/{id}/retry` for path-based jobs; return 409 for
  uploaded jobs whose temp path was cleaned, with a clear app-side “choose
  folder” path. Add `status`, `project`, `limit/cursor` filters to
  `GET /api/v1/scans`.
- App scan center:
  - Status filters and load-more pagination.
  - Retry failed path jobs; “Scan again…” fallback for upload jobs.
  - Cancel all queued/running (with confirmation).
  - Queue-position display for queued jobs.
  - Pre-drop validation: file count, extensions, size, and a preview before
    starting; warn when zero IaC files.
  - Job deep links from notifications.
- Retention: configurable job history cleanup server-side; app shows
  “history trimmed”.

### Updates

- Auto-check interval preference (off/daily/weekly) and last-checked time.
- Stable/beta channels (separate feed URLs) in Settings.
- “Remind me later” with a stored snooze until timestamp.
- Rendered release notes (Markdown with a safe subset).
- Download location display / “Show in folder”.
- Install verification:
  - Exercise the real open-installer path in CI with a dummy local file and
    confirm the OS handoff, without silently installing.
  - Signed/notarized builds when Apple credentials exist; until then keep the
    ad-hoc/“Open anyway” guidance.
  - Windows/Linux installer formats documented and tested manually.

### Tests / gate

- Scan retry works for path jobs and gives a clear fallback for uploads.
- Filters/pagination and cancel-all update the drawer correctly.
- Update auto-check/snooze/channel selection works.
- Download checksum failure and cancelled download leave a recoverable state.

## U7.3 Resilience, privacy and OS integration

Covers P1-11, P1-12 and P1-13.

### Resilience

- Health checks use exponential backoff + jitter; no retry storms when offline.
- Per-panel stale indicators: “last updated 4m ago” on widgets, jobs,
  notifications and run context.
- Offline actions explain themselves (“Scanning needs the server”) instead of
  failing silently; no queuing of destructive actions.
- Safe-mode indicator in the normal shell: “Shell UI disabled — relaunch
  normally” with a Relaunch action.
- Persist crash-loop state so a repeated crash does not reset the counter on
  quick relaunches.
- Optional opt-in crash reporting (Crashpad/Sentry) with a clear privacy
  explanation.

### Privacy/security UX

- First clipboard scan shows a consent/preview explaining that code is sent to
  the configured server; remember the choice.
- Device/token audit view with created/last-used/revoked state and “Sign out
  all devices”.
- “Clear local data” (tokens, recents, cached summaries, window state) with
  confirmation.
- Diagnostics preview before copy/save; redaction summary shown.
- External links to non-allowlisted hosts show the destination before opening.
- Update feed URL is shown in diagnostics as a redacted/origin-only URL.

### OS integration

- macOS: dock menu (New Scan, Open Latest Run), Services/Share entry, menu-bar
  tooltip with environment + health.
- Windows: jump list (New Scan, Open Dashboard), taskbar progress/overlay for
  running scans, overlay badge for unread.
- Linux: AppIndicator behavior, notification actions, `.desktop` file and
  protocol registration notes.
- File associations/protocol: folder-open and `wombatpass://` handling on all
  platforms; document OS-specific registration.

### Tests / gate

- Offline retry backoff observed; no more than one health request per interval.
- Stale badges appear/disappear correctly.
- Clipboard consent cannot be bypassed silently.
- Clear-local-data removes tokens and recents while leaving the server intact.
- OS integration smoke tests/checklists per platform.

---

# U8 — Refinement (Tier 2)

## U8.1 Interface polish

Covers P2-14.

- Skeleton loaders for widgets, palette, jobs and notifications.
- First-run empty states: no runs, no controls, no notifications, no devices.
- Tooltips for every icon-only control; consistent shortcut hints.
- Undo for destructive-but-reversible actions (close tab, clear recents,
  remove environment) where feasible.
- Toast history accessible from the bell panel.
- Palette result previews (project/score/stage) and match highlighting.
- Recent/favourite/pinned commands; per-environment recent searches.
- Zoom and density controls persisted per profile.
- Keyboard remapping for shell shortcuts (with conflict detection).

## U8.2 Help, release notes and licensing

Covers P2-15.

- In-app release notes with the same content as `whats-new.json`.
- Documentation links per feature, contextual Help buttons.
- License acknowledgements from the SBOM in Help → About.
- Support bundle: diagnostics + screenshot + active environment snapshot.
- Searchable Help; shortcut cheat sheet overlay (`?`).

## U8.3 Crash reporting and diagnostics maturity

Covers P2-16.

- Opt-in crash reporting with a clear scope and local “view report” before send.
- Persist crash metadata across launches; show “last crash” in Help.
- Crash-loop detection with a safe-mode recommendation.
- Diagnostics export includes recent app metrics (memory, startup timings,
  active tab count) without user data.
- A normal-UI “Copy diagnostics” action in Help and Settings → Advanced.

---

# Server contract changes (explicit)

| Change | Wave | Notes |
|---|---|---|
| Notifications: `target_user_id`, link metadata, per-user permissions, pagination | U6.3 | Migration 0060; admin “see all” retained |
| Sessions list/revoke | U6.2 | Endpoints already exist; verify non-admin and self-scope tests |
| Device expiry (optional) | U6.2 | Decision required; if accepted, migration 0061 + UI expiry badge |
| Scan retry endpoint + list filters | U7.2 | No migration required for retry; index/filters if needed |
| Scan retention/cleanup setting | U7.2 | Reuse existing cleanup path; document |
| Notification links on creation | U6.3 | `link_route`, `link_run_id`, `link_url` |
| Crash reporting backend | U8.3 | Opt-in only; no PII; can be local-first |

No other server changes are required for U6–U8.

# Test plan

## CI matrix

- macOS 14, Windows 2022, Ubuntu 22.04.
- Node/Electron versions pinned.
- Linux uses `xvfb-run`; tray tests use a feature probe and skip when no
  indicator is available.
- Artifacts: logs, screenshots, axe reports, crash reports.

## New automated tests

- `test:auth-lifecycle` — expire access, re-auth, revoke device, session list.
- `test:notifications-user` — non-admin sees own notifications, isolation,
  link metadata, read/all.
- `test:a11y-full` — tab strip, onboarding, crash page, shadow-root app bar.
- `test:i18n-pseudo` — pseudo-locale leak check.
- `test:visual` — platform/theme screenshot baselines.
- `test:perf` — startup/palette/tab budgets.
- `test:settings-state` — apply/revert, restart banner, unsaved guard.
- `test:tabs-full` — reorder, overflow, duplicate, context menu, active restore.
- `test:scan-ops` — retry, filters, pagination, cancel all, pre-drop preview.
- `test:update-lifecycle` — auto-check, snooze, channel, failed checksum,
  install confirmation path.
- `test:resilience` — backoff, stale badges, safe-mode indicator, crash loop.
- `test:privacy` — clipboard consent, clear local data, diagnostics preview.

## Manual matrix

- Three OSes, two themes + high contrast, 100/125/150%, multi-monitor,
  fullscreen, narrow windows, keyboard-only, screen reader.
- Real update feed and signed/notarized install where available.
- Offline → reconnect → retry; auth expiry → re-auth; revoked device.
- Tab save/restore and crash of a background tab.

# Decisions and recommended defaults

1. **Notifications become per-user** (with role/audience targeting).
   Admin “see all” remains. This is required for parity.
2. **Reuse the existing session API** rather than inventing a new one.
3. **Device tokens default to no expiry**; add optional expiry only if the
   deployment policy needs it. Surface revoked/expired clearly either way.
4. **Auto-update remains download-and-open** until a signed/notarized build
   exists; then add `electron-updater` as a separate opt-in decision.
5. **Pseudo-locale is a CI gate**, not just a test aid.
6. **Visual baselines are platform-specific**, not cross-platform diffs.
7. **Crash reporting is opt-in**, local-first, with a report preview.
8. **Tabs stay default-on for Windows/Linux**, with `WOMBAT_UI_TABS=0` as the
   rollback.

# Effort and sequencing

| Wave | Work | Estimate | Depends on |
|---|---|---|---|
| U6.1 | Platform CI, Windows overlay, Linux tray, manual matrix | 3–4 d | — |
| U6.2 | Auth/session lifecycle, re-auth, sessions UI | 3–4 d | U6.1 CI |
| U6.3 | Notification server migration + app parity | 3–4 d | U6.1 CI |
| U6.4 | Accessibility completion | 2–3 d | U6.1 |
| U6.5 | Localization completion + pseudo-locale | 2–3 d | U6.1 |
| U6.6 | Visual snapshots + performance budgets | 2–3 d | U6.1–U6.5 |
| U7.1 | Settings semantics + tab robustness | 3–4 d | U6 |
| U7.2 | Scan/update operations | 4–5 d | U6.2/U6.3 |
| U7.3 | Resilience/privacy/OS integration | 4–5 d | U6 |
| U8.1–U8.3 | Refinement, help, crash reporting | 4–6 d | U7 |

Sub-waves can be done in parallel, but each ships only after its gate.

# Definition of mature

- CI runs the shell suites on macOS, Windows and Linux.
- Every P0 item has an automated test or a documented manual gate.
- Auth expiry, revoked devices and backend loss have one-click recovery.
- Non-admin users get real notifications with deep links.
- axe reports no critical/serious issues on every shell surface.
- Pseudo-locale shows no untranslated shell strings.
- Visual snapshots and performance budgets are enforced in CI.
- Settings cannot silently lose changes; tabs cannot silently lose state.
- Updates are checksum-verified, signed/notarized where available, and never
  install silently.
- Privacy-sensitive actions explain what leaves the machine and how to clear
  local data.
