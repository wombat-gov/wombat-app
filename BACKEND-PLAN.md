# Backend plan — six server features for the desktop app

> **Status (2026-11-07):** Waves A, B, C and D are implemented.
>
> - **A:** `GET /api/v1/desktop/summary` and `GET /api/v1/events` (SSE) are live,
>   with event replay, mandate filtering, desktop summary integration and
>   fallbacks in the app.
> - **B:** `scan_jobs` (migration 0057), `POST /api/v1/scans`,
>   `POST /api/v1/scans/upload`, job status/list/cancel, an in-process worker
>   with progress events, and app upload/progress/cancel with a Docker fallback.
> - **C:** `GET /api/v1/search` across runs, findings, controls, waivers, risks
>   and projects with `pg_trgm` GIN indexes (migration 0058); the palette now
>   queries it, with the local cache retained as a fallback.
> - **D:** `device_codes` + `devices` (migration 0059), browser approval page,
>   one-time code exchange, opaque hashed Bearer device tokens accepted by
>   `get_current_user`, list/revoke endpoints, and encrypted per-environment
>   tokens in the app with proxy injection and Settings sign-in/sign-out.
>
> All four planned waves are now implemented.

This plan covers the server-side work that pairs with the app-only features.
It is additive: no existing endpoint changes behaviour, and every feature keeps
working with the current dashboard.

Target repo: `wafpass-server/` (FastAPI, SQLAlchemy async, Postgres, Alembic).
Client: the Electron shell in `wombat-app/`, portable to Windows/Linux.

Guiding rules:

- Reuse `get_auth_context`, role checks, mandate scoping and audit logging.
- One Alembic migration per wave; tests in `wafpass-server/tests/`.
- No secrets in the client; device tokens are hashed at rest.
- SSE and jobs must degrade gracefully (polling fallback, DB-backed state).
- Each wave ends with a Docker rebuild and an app smoke test.

---

## 1. Desktop summary endpoint (quick win)

`GET /api/v1/desktop/summary?project=<optional>`

Why: the popover currently makes 4–5 calls per refresh (runs, detail,
notifications, waivers, risks). One aggregated, mandate-scoped call is cheaper,
consistent and easier to extend.

Response:

```json
{
  "generated_at": "2026-11-07T14:00:00Z",
  "version": "1.2.0",
  "latest_run": { "id": "...", "project": "wombat-demo", "score": 0,
                  "failed_controls": 8, "controls_run": 97, "created_at": "..." },
  "trend": [72, 68, 70, 0],
  "projects": ["wombat-demo", "wafpass-demo"],
  "notifications": { "unread": 1 },
  "governance": { "expiring": 2, "expired": 0,
                  "next": [{ "type": "waiver", "project": "...", "days": 3 }] },
  "digest": { "runs_24h": 3, "projects_24h": 2 }
}
```

Implementation:

- New router `routers/desktop.py`; Pydantic response models in `schemas.py`.
- Queries through the scoped session (mandate/project filters); latest run +
  last 10 scores; distinct projects; unread notifications; expiry from
  `waivers`/`risks`.
- In-process cache (~10 s) keyed by user/mandate/project; invalidated by the
  event bus (wave 2) if present.
- No schema changes.

Tests: role/mandate scoping, project filter, empty database, unread counts.

App integration: `src/widgets.js` replaces its run/notification/governance
fetches with one call; `/health` and Docker stay host-side.

---

## 2. Event stream (SSE)

`GET /api/v1/events` — cookie or Bearer auth, `text/event-stream`.

Why: live widgets, instant notifications and scan progress without 15 s
polling; also enables live dashboard updates later.

Events:

```
event: run.created      data: {"id": "...", "project": "...", "score": 0}
event: scan.progress    data: {"job_id": "...", "percent": 42, "stage": "checks"}
event: notification.created data: {"id": "...", "title": "..."}
event: waiver.changed   data: {"id": "...", "action": "upsert"}
event: risk.changed     data: {"id": "...", "action": "delete"}
```

Implementation:

- `EventBus` module: per-subscriber `asyncio.Queue`, bounded replay deque (500
  events) for `Last-Event-ID`; heartbeat comment every 20 s.
- Publish from existing write paths (runs create/update, notifications, waivers,
  risks, scan jobs). Optional Redis pub/sub when `WOMBAT_REDIS_URL` is set, for
  multi-replica deployments.
- Auth and mandate scoping at subscribe time; filter events per mandate/user.
- Disconnect cleanup and slow-consumer drop policy.

Tests: auth required, delivery, replay with `Last-Event-ID`, disconnect cleanup,
mandate filtering.

App integration: subscribe in the main process (Node streaming fetch), push to
the popover/windows; keep polling as a fallback when the stream is down.

---

## 3. Async scan jobs + progress/cancel

Today `POST /api/v1/scan` runs `run_scan()` synchronously in the request handler,
blocking the event loop for the whole scan and risking HTTP timeouts.

New endpoints:

- `POST /api/v1/scans` → `202 { "job_id": "..." }`
- `GET /api/v1/scans/{job_id}` → status/progress/run_id/error
- `POST /api/v1/scans/{job_id}/cancel`
- `GET /api/v1/scans?limit=20` (recent jobs, optional)

Schema (`scan_jobs`):

| column | notes |
|---|---|
| id | UUID PK |
| user_id / mandate_id | scoping |
| project, path, iac | request |
| status | queued / running / succeeded / failed / cancelled |
| progress | 0–100 |
| run_id | on success |
| error | on failure |
| created_at, started_at, finished_at | timestamps |

Worker:

- DB-backed queue with `FOR UPDATE SKIP LOCKED` (safe for multiple replicas);
  single worker for local.
- Run the CPU-bound engine in `asyncio.to_thread` (or a process pool) so the API
  stays responsive.
- Emit `scan.progress`/`scan.completed`/`scan.failed` on the event bus; update
  the job row.
- Keep the existing `/scan` endpoint for compatibility (delegate to the new
  pipeline if desired).

Security: same `resolve_scan_path` validation, engineer+ role, audit entry,
concurrency limit per user.

Tests: state transitions, cancel, concurrent limit, failure and cleanup.

App integration: folder scan and watch mode create a job, show progress in the
drop-zone/stack windows, and open the run on completion.

---

## 4. Upload-and-scan

`POST /api/v1/scans/upload` — multipart `file` (zip/tar.gz) + project/iac.

Why: removes the local-Docker/`docker cp` requirement and works with remote
servers. Pairs with wave 3 (returns a job id).

Rules:

- Compressed ≤ 50 MB, extracted ≤ 200 MB, ≤ 5,000 files.
- Allowlisted extensions (`.tf`, `.tfvars`, `.hcl`, `.yaml`, `.yml`, `.json`,
  `.template`, `.bicep`); reject symlinks, absolute paths, `..` escapes,
  device files.
- Extract into a temp dir under `WOMBAT_SCAN_BASE_DIR`, scan, delete in a
  `finally`; audit upload and result.
- Validate `iac` and project name; strip control characters.

Tests: zip-slip, symlink, oversized archive, wrong content type, happy path.

App integration: build a zip of the staged IaC files (same collector as the
current `docker cp` path), upload with `FormData`, then poll/observe the job.

---

## 5. Global search API

`GET /api/v1/search?q=<text>&types=runs,findings,controls,waivers,risks,projects&limit=20`

Response items:

```json
{ "type": "run", "id": "...", "title": "wombat-demo", "subtitle": "score 0 · 2h",
  "route": "dashboard", "score": 12.4 }
```

Implementation:

- Postgres `pg_trgm` (migration: `CREATE EXTENSION IF NOT EXISTS pg_trgm`) and
  GIN indexes on names/descriptions; `tsvector` for findings if needed.
- Rank by similarity + recency; scope by mandate/role; cap `q` length (e.g.,
  100 chars); limit per type.
- Stable ordering and a small result cache.

Tests: ranking sanity, scoping, empty query, very long query, no results.

App integration (implemented): the ⌘⇧K palette calls this after a 250 ms
debounce instead of fetching 200 runs and 500 controls. Results map to run,
finding, control, waiver, risk and project commands; local pages, environments
and actions still come from the client-side cache, which is also the fallback
when `/search` returns 404/501 or the network fails.

---

## 6. Device authorization (SSO / remote)

Why: cookie auth through the loopback proxy works locally, but remote/SSO
installations need a first-class desktop login.

Flow:

1. `POST /api/v1/auth/device/start` → `{ device_code, user_code, verification_url, interval }`
2. The app opens `verification_url` in the system browser; the user approves
   with their normal session.
3. The app polls `POST /api/v1/auth/device/token` with `device_code`.
4. On approval it receives an opaque device token (hashed at rest, scoped to the
   user/mandate); store it in the macOS Keychain / Windows DPAPI via
   `safeStorage`.
5. `GET/DELETE /api/v1/auth/devices` to list/revoke.

Schema: `device_codes` (hash, user_code, expires_at, approved_by, consumed_at)
and `devices` (id, user_id, name, token_hash, created_at, last_used_at,
revoked_at).

Security: short expiry (10 min), one-time codes, rate limits on start/token,
device name validation, audit every approval/revocation.

Tests: expiry, reuse, revocation, rate limiting, role resolution.

App integration (implemented): settings starts `/auth/device/start`, opens the
verification URL, polls `/auth/device/token`, stores the token with
`safeStorage` per environment, and injects it into the loopback proxy. The
cookie path remains for local/older servers. Sign-out revokes the token before
clearing it locally.

---

## Waves and gates

Each wave: migration + router + tests + Docker rebuild, then app integration and
`npm run test:smoke`.

| Wave | Features | Exit gate |
|---|---|---|
| A | 1 + 2 (summary, SSE) | app widgets use one call and update live; stream reconnect test |
| B | 3 + 4 (jobs, upload) | folder scan works against a remote server without Docker |
| C | 5 (search) | palette results come from `/search` and are scoped correctly — **done** (`npm run test:palette`, `tests/test_search.py`) |
| D | 6 (device auth) | browser approval → token → API call, revoke works — **done** (`tests/test_device_auth.py`, `npm run test:device`) |

## Client portability notes

- SSE: use Node's streaming `fetch`/`http` in the main process; no renderer
  dependency, so Windows/Linux are unaffected.
- Uploads: `FormData`/`Blob` are available in Electron's Node runtime; no native
  modules.
- Device tokens: `safeStorage` is cross-platform (Keychain / DPAPI / libsecret).
- Job polling and progress UI are plain IPC, shared by all platforms.

## Honourable mentions (later)

Scheduled scans and GitHub/GitLab webhook ingestion; server-side evidence/report
artifacts with signed download URLs; a run-diff endpoint for native-tab
comparison; richer `/system/status` (version, DB latency, engine availability).
