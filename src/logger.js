/**
 * Small rotating file logger for the desktop shell.
 *
 * Writes to ~/Library/Logs/WOMBATpass Dashboard/main.log and mirrors to the
 * console. Rotation keeps one previous file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const MAX_BYTES = 2 * 1024 * 1024

let logFile = ''
let initialized = false

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function initLogger() {
  if (initialized) return
  initialized = true
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, 'main.log')
    try {
      const stat = fs.statSync(logFile)
      if (stat.size > MAX_BYTES) {
        fs.rmSync(path.join(dir, 'main.old.log'), { force: true })
        fs.renameSync(logFile, path.join(dir, 'main.old.log'))
      }
    } catch {
      /* no log yet */
    }
  } catch {
    logFile = ''
  }
}

export function getLogPath() {
  return logFile
}

export function log(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}${extra === undefined ? '' : ` ${safeJson(extra)}`}\n`
  if (level === 'error') console.error(line.trimEnd())
  else console.log(line.trimEnd())
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, line)
  } catch {
    /* logging must never throw */
  }
}

export const logger = {
  info: (message, extra) => log('info', message, extra),
  warn: (message, extra) => log('warn', message, extra),
  error: (message, extra) => log('error', message, extra),
}
