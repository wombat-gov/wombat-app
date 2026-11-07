/**
 * Server-Sent Events client for the dashboard session.
 *
 * Runs in the Electron main process, uses the loopback proxy (so cookies are
 * first-party), reconnects with exponential backoff and Last-Event-ID replay,
 * and stops quietly when the server predates the endpoint (404/501).
 */
import { session } from 'electron'

import { logger } from './logger.js'
import { SESSION_PARTITION } from './security.js'

const HEARTBEAT_TIMEOUT_MS = 45_000
const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const AUTH_RETRY_MS = 15_000

export function createEventStream({ origin, getContext, onEvent, onStatus }) {
  let stopped = true
  let controller = null
  let retryTimer = null
  let heartbeatTimer = null
  let retryDelay = BASE_RETRY_MS
  let lastEventId = ''

  function setStatus(status) {
    try {
      onStatus?.(status)
    } catch {
      /* ignore */
    }
  }

  function schedule(delay) {
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, delay)
  }

  function resetHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      // No bytes (not even a heartbeat comment) — force a reconnect.
      try {
        controller?.abort()
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_TIMEOUT_MS)
  }

  function parseChunk(chunk) {
    let id = ''
    let type = 'message'
    const dataLines = []

    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }

    if (dataLines.length === 0) return
    if (id) lastEventId = id

    let data = {}
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      data = { raw: dataLines.join('\n') }
    }

    try {
      onEvent?.({ id, event: type, data })
    } catch (error) {
      logger.warn('event handler failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function connect() {
    if (stopped) return

    let context = {}
    try {
      context = (await getContext?.()) ?? {}
    } catch {
      context = {}
    }

    const headers = { accept: 'text/event-stream' }
    if (context?.mandant) headers['X-Mandant-Context'] = String(context.mandant)
    if (lastEventId) headers['Last-Event-ID'] = lastEventId

    controller = new AbortController()

    try {
      const ses = session.fromPartition(SESSION_PARTITION)
      const response = await ses.fetch(`${origin}/api/v1/events`, {
        headers,
        credentials: 'include',
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        setStatus('auth')
        schedule(AUTH_RETRY_MS)
        return
      }
      if (response.status === 404 || response.status === 501) {
        setStatus('unsupported')
        return
      }
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }

      setStatus('connected')
      retryDelay = BASE_RETRY_MS
      resetHeartbeat()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        resetHeartbeat()
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          parseChunk(chunk)
          boundary = buffer.indexOf('\n\n')
        }
      }

      if (!stopped) throw new Error('event stream ended')
    } catch (error) {
      if (stopped) return
      setStatus('disconnected')
      const message = error instanceof Error ? error.message : String(error)
      if (!/aborted/i.test(message)) {
        logger.warn('event stream', { message })
      }
      schedule(retryDelay)
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
    } finally {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer)
        heartbeatTimer = null
      }
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      retryTimer = null
      heartbeatTimer = null
      try {
        controller?.abort()
      } catch {
        /* ignore */
      }
      controller = null
      setStatus('stopped')
    },
  }
}
