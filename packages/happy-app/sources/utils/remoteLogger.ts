/**
 * Remote logger for React Native
 * Patches console to send logs to a local log receiver server
 * Configure via Dev screen → Log Server setting
 */

import { getLogServerUrl } from '@/sync/serverConfig';
import { Platform } from 'react-native';

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = 1000

export function initRemoteLogging() {
  const logServerUrl = getLogServerUrl();
  if (!logServerUrl) {
    return
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  const sendLog = async (level: string, args: any[]) => {
    try {
      await fetch(logServerUrl + '/logs', {
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
      originalConsole[level](...args)

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

      // Send to remote
      sendLog(level, args)
    }
  })

  originalConsole.log('[RemoteLogger] Initialized with log server:', logServerUrl)
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
