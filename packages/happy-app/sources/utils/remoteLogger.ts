/**
 * Simple remote logger for React Native
 * Patches console to send logs to remote server
 * 
 * ONLY ENABLE IN LOCAL BUILD
 * PRIMARILY FOR AI AUTO DEBUGGING
 */

import { config } from '@/config';


let logBuffer: any[] = []
const MAX_BUFFER_SIZE = 1000

export function monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds() {
  // NEVER ENABLE REMOTE LOGGING IN PRODUCTION
  // This is for local debugging with AI only
  // So AI will have all the logs easily accessible in one file for analysis
  if (!process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
    return
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  const url = config.serverUrl
  
  if (!url) {
    console.log('[RemoteLogger] No server URL provided, remote logging disabled')
    return
  }

  const sendLog = async (level: string, args: any[]) => {
    try {
      await fetch(url + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
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
          platform: 'ios', // or android
        })
      })
    } catch (e) {
      // console.error('[RemoteLogger] Failed to send log:', e)
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

  console.log('[RemoteLogger] Initialized with server:', url)
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}