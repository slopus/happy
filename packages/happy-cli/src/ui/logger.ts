/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: ~/.handy/logs/<date time in local timezone>.log
 */

import chalk from 'chalk'
import { appendFileSync } from 'fs'
import { inspect } from 'node:util'
import { configuration } from '@/configuration'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
// Note: readDaemonState is imported lazily inside listDaemonLogFiles() to avoid
// circular dependency: logger.ts ↔ persistence.ts

const REDACTED = '[REDACTED]'
const MAX_LOG_SANITIZE_DEPTH = 8

function isSensitiveLogKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')

  return /(?:authorization|cookie|token|secret|password|passwd|apikey|credential|privatekey|sessionkey)$/.test(normalizedKey)
}

export function redactSensitiveLogString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;\\]+/gi, `$1 ${REDACTED}`)
    .replace(
      /((?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|refresh_token|id_token|api_key|token|secret|password)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
}

export function redactSensitiveLogValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth: number = 0,
): unknown {
  if (typeof value === 'string') {
    return redactSensitiveLogString(value)
  }

  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value
  }

  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value)
  }

  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`
  }

  if (depth >= MAX_LOG_SANITIZE_DEPTH) {
    return '[Max Depth]'
  }

  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof RegExp) {
    return value.toString()
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  }

  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveLogValue(item, seen, depth + 1))
  }

  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, entryValue]) => [
      redactSensitiveLogValue(key, seen, depth + 1),
      redactSensitiveLogValue(entryValue, seen, depth + 1),
    ])
  }

  if (value instanceof Set) {
    return Array.from(value, item => redactSensitiveLogValue(item, seen, depth + 1))
  }

  const result: Record<string, unknown> = {}
  const keys = new Set(Object.keys(value))
  if (value instanceof Error) {
    keys.add('name')
    keys.add('message')
    keys.add('stack')
    if ('cause' in value) {
      keys.add('cause')
    }
  }

  for (const key of keys) {
    if (isSensitiveLogKey(key)) {
      result[key] = REDACTED
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) {
      continue
    }
    if (!('value' in descriptor)) {
      result[key] = '[Getter]'
      continue
    }

    result[key] = redactSensitiveLogValue(descriptor.value, seen, depth + 1)
  }

  return result
}

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(configuration.logsDir, filename)
}

class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    // Remote logging enabled only when explicitly set with server URL
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING 
      && process.env.HAPPY_SERVER_URL) {
      this.dangerouslyUnencryptedServerLoggingUrl = process.env.HAPPY_SERVER_URL
      console.log(chalk.yellow('[REMOTE LOGGING] Sending logs to server for AI debugging'))
    }
  }

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)

    // NOTE: @kirill does not think its a good ideas,
    // as it will break us using claude in interactive mode.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
    if (!process.env.DEBUG) {
      this.debug(`In production, skipping message inspection`)
    }

    // Some of our messages are huge, but we still want to show them in the logs
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.length > maxStringLength 
          ? obj.substring(0, maxStringLength) + '... [truncated for logs]'
          : obj
      }
      
      if (Array.isArray(obj)) {
        const truncatedArray = obj.map(item => truncateStrings(item)).slice(0, maxArrayLength)
        if (obj.length > maxArrayLength) {
          truncatedArray.push(`... [truncated array for logs up to ${maxArrayLength} items]` as unknown)
        }
        return truncatedArray
      }
      
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'usage') {
            // Drop usage, not generally useful for debugging
            continue
          }
          result[key] = truncateStrings(value)
        }
        return result
      }
      
      return obj
    }

    const truncatedObject = truncateStrings(redactSensitiveLogValue(object))
    const json = JSON.stringify(truncatedObject, null, 2)
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }
  
  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    this.debug(message, args)
  }
  
  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args)
    
    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }
  
  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    this.debug(`[WARN] ${message}`, ...args)
  }
  
  getLogPath(): string {
    return this.logFilePath
  }
  
  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    const safeMessage = redactSensitiveLogString(message)
    const safeArgs = args.map(arg => redactSensitiveLogValue(arg))

    switch (level) {
      case 'debug': {
        console.log(chalk.gray(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'error': {
        console.error(chalk.red(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'info': {
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'warn': {
        console.log(chalk.yellow(prefix), safeMessage, ...safeArgs)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }
    }
  }

  private async sendToRemoteServer(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.dangerouslyUnencryptedServerLoggingUrl) return

    const safeMessage = redactSensitiveLogString(message)
    const safeArgs = args.map(arg => redactSensitiveLogValue(arg))
    
    try {
      await fetch(this.dangerouslyUnencryptedServerLoggingUrl + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: `${safeMessage} ${safeArgs.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
          ).join(' ')}`,
          source: 'cli',
          platform: process.platform
        })
      })
    } catch (error) {
      // Silently fail to avoid disrupting the session
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const safePrefix = redactSensitiveLogString(prefix)
    const safeMessage = redactSensitiveLogString(message)
    const safeArgs = args.map(arg => redactSensitiveLogValue(arg))
    const logLine = `${safePrefix} ${safeMessage} ${safeArgs.map(arg =>
      typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
    ).join(' ')}\n`
    
    // Send to remote server if configured
    if (this.dangerouslyUnencryptedServerLoggingUrl) {
      // Determine log level from prefix
      let level = 'info'
      if (prefix.includes(this.localTimezoneTimestamp())) {
        level = 'debug'
      }
      // Fire and forget, with explicit .catch to prevent unhandled rejection
      this.sendToRemoteServer(level, safeMessage, ...safeArgs).catch(() => {
        // Silently ignore remote logging errors to prevent loops
      })
    }
    
    // Handle async file path
    try {
      appendFileSync(this.logFilePath, logLine)
    } catch (appendError) {
      if (process.env.DEBUG) {
        console.error('[DEV MODE ONLY THROWING] Failed to append to log file:', appendError)
        throw appendError
      }
      // In production, fail silently to avoid disturbing Claude session
    }
  }
}

// Will be initialized immideately on startup
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Lazy import to avoid circular dependency: logger.ts ↔ persistence.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
