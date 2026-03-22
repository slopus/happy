/**
 * Console logging bootstrap for React Native
 * Patches console to feed the in-app log buffer and optionally send logs to a local log receiver server
 * Configure via Dev screen → Log Server setting
 */

import { log } from '@/log';
import { MAX_APP_LOG_ENTRIES } from '@/log';
import { getLogServerUrl } from '@/sync/serverConfig';
import { Platform } from 'react-native';

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = MAX_APP_LOG_ENTRIES
let isConsolePatched = false
let remoteLogServerUrl: string | null = null
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

export function initConsoleLogging() {
  remoteLogServerUrl = getLogServerUrl();

  if (isConsolePatched) {
    return
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  const sendLog = async (level: string, args: any[]) => {
    if (!remoteLogServerUrl) {
      return
    }

    try {
      await fetch(remoteLogServerUrl + '/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
          ).join('\n'),
          messageRawObject: args,
          source: 'mobile',
          platform: Platform.OS,
        })
      })
    } catch (e) {
      // Fail silently
    }
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    console[level] = (...args: any[]) => {
      // Always call original
      originalConsole![level](...args)

      // Mirror console output into the in-app log buffer
      log.captureConsole(level, args)

      // Buffer for developer settings
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: args
      }
      logBuffer.push(entry)
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

      // Send to remote if configured
      void sendLog(level, args)
    }
  })

  isConsolePatched = true

  if (remoteLogServerUrl) {
    originalConsole.log('[ConsoleLogging] Initialized with log server:', remoteLogServerUrl)
  } else {
    originalConsole.log('[ConsoleLogging] Console capture initialized without remote log server')
  }
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
