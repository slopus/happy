/**
 * Console logging bootstrap for React Native
 *
 * Control flow:
 *
 * console.log("msg", obj)
 * │
 * ├─ consoleOutputEnabled = false? (default for prod)
 * │  └─ return immediately ⛔  (zero cost, args untouched)
 * │
 * ├─ consoleOutputEnabled = true? (default for dev/preview, or toggled on)
 * │  ├─ call original console method ✅
 * │  ├─ capture to in-app buffer ✅
 * │  └─ send to remote log server (if configured) ✅
 * │
 * └─ console.error / console.warn (always, regardless of flag)
 *    ├─ call original console method ✅
 *    ├─ capture to in-app buffer ✅
 *    └─ send to remote log server (if configured) ✅
 */

import { log } from '@/log';
import { MAX_APP_LOG_ENTRIES } from '@/log';
import { getLogServerUrl } from '@/sync/serverConfig';
import { loadLocalSettings } from '@/sync/persistence';
import { loadAppConfig } from '@/sync/appConfig';
import { Platform } from 'react-native';

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = MAX_APP_LOG_ENTRIES
let isConsolePatched = false
let remoteLogServerUrl: string | null = null
let consoleOutputEnabled = false
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

/**
 * Toggle console output at runtime (e.g. from Dev screen toggle).
 */
export function setConsoleOutputEnabled(enabled: boolean) {
  consoleOutputEnabled = enabled
}

export function initConsoleLogging() {
  if (isConsolePatched) {
    return
  }

  remoteLogServerUrl = getLogServerUrl();

  // Determine initial state: user setting > build variant default > off
  try {
    const settings = loadLocalSettings();
    const config = loadAppConfig();
    consoleOutputEnabled = settings.consoleLoggingEnabled || config.consoleLoggingDefault || false;
  } catch {
    consoleOutputEnabled = false;
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  function formatArgs(args: any[]): string {
    return args.map(a =>
      typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
    ).join(' ')
  }

  function sendLog(level: string, formatted: string) {
    if (!remoteLogServerUrl) {
      return
    }

    void fetch(remoteLogServerUrl + '/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: formatted,
        source: 'mobile',
        platform: Platform.OS,
      })
    }).catch(() => {})
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    const alwaysPassThrough = level === 'error' || level === 'warn'

    console[level] = (...args: any[]) => {
      // Full short-circuit: when off, skip everything for log/info/debug
      if (!consoleOutputEnabled && !alwaysPassThrough) {
        return
      }

      // Serialize once, reuse everywhere
      const formatted = formatArgs(args)

      originalConsole![level](formatted)
      log.captureFormatted(level, formatted)

      logBuffer.push({
        timestamp: new Date().toISOString(),
        level,
        message: formatted
      })
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

      sendLog(level, formatted)
    }
  })

  isConsolePatched = true

  originalConsole.log('[ConsoleLogging] Initialized', consoleOutputEnabled ? '(output enabled)' : '(output suppressed)')
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
