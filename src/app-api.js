/**
 * Main-process API client.
 *
 * Uses the dashboard's persistent session and mirrors the renderer's
 * double-submit CSRF header: unsafe requests read the `wombat_csrf` cookie
 * and send it as `X-CSRF-Token`.
 */
import { session } from 'electron'

import { SESSION_PARTITION } from './security.js'

export async function appFetch(origin, path, init = {}) {
  const ses = session.fromPartition(SESSION_PARTITION)
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? {})

  if (!headers.has('accept')) headers.set('accept', 'application/json')

  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const cookies = await ses.cookies.get({ url: origin, name: 'wombat_csrf' })
      const token = cookies?.[0]?.value
      if (token) headers.set('X-CSRF-Token', token)
    } catch {
      /* no CSRF cookie yet; the server will reject with 403 */
    }
  }

  return ses.fetch(`${origin}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  })
}
