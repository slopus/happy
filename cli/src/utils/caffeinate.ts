/**
 * Caffeinate utility for preventing macOS from sleeping
 * Uses the built-in macOS caffeinate command to keep the system awake
 */

import { spawn, ChildProcess } from 'child_process'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'

let caffeinateProcess: ChildProcess | null = null

/**
 * Start caffeinate to prevent system sleep
 * Only works on macOS, silently does nothing on other platforms
 * 
 * @returns true if caffeinate was started, false otherwise
 */
export function startCaffeinate(): boolean {
    // Check if caffeinate is disabled via configuration
    if (configuration.disableCaffeinate) {
        logger.debug('[caffeinate] Caffeinate disabled via HAPPY_DISABLE_CAFFEINATE environment variable')
        return false
    }

    // Only run on macOS
    if (process.platform !== 'darwin') {
        logger.debug('[caffeinate] Not on macOS, skipping caffeinate')
        return false
    }

    // Don't start if already running
    if (caffeinateProcess && !caffeinateProcess.killed) {
        logger.debug('[caffeinate] Caffeinate already running')
        return true
    }

    try {
        // Spawn caffeinate with flags:
        // -i: Prevent system from idle sleeping  
        // -m: Prevent disk from sleeping
        caffeinateProcess = spawn('caffeinate', ['-im'], {
            stdio: 'ignore',
            detached: false
        })

        caffeinateProcess.on('error', (error) => {
            logger.debug('[caffeinate] Error starting caffeinate:', error)
            caffeinateProcess = null
        })

        caffeinateProcess.on('exit', (code, signal) => {
            logger.debug(`[caffeinate] Process exited with code ${code}, signal ${signal}`)
            caffeinateProcess = null
        })

        logger.debug(`[caffeinate] Started with PID ${caffeinateProcess.pid}`)
        
        // Set up cleanup handlers
        setupCleanupHandlers()
        
        return true
    } catch (error) {
        logger.debug('[caffeinate] Failed to start caffeinate:', error)
        return false
    }
}

let isStopping = false

/**
 * Stop the caffeinate process
 */
export async function stopCaffeinate(): Promise<void> {
    // Prevent re-entrant calls during cleanup
    if (isStopping) {
        logger.debug('[caffeinate] Already stopping, skipping')
        return
    }
    
    if (caffeinateProcess && !caffeinateProcess.killed) {
        isStopping = true
        logger.debug(`[caffeinate] Stopping caffeinate process PID ${caffeinateProcess.pid}`)
        
        try {
            caffeinateProcess.kill('SIGTERM')
            
            // Give it a moment to terminate gracefully
            await new Promise(resolve => setTimeout(resolve, 1000))

            if (caffeinateProcess && !caffeinateProcess.killed) {
                logger.debug('[caffeinate] Force killing caffeinate process')
                caffeinateProcess.kill('SIGKILL')
            }
            caffeinateProcess = null
            isStopping = false
        } catch (error) {
            logger.debug('[caffeinate] Error stopping caffeinate:', error)
            isStopping = false
        }
    }
}

/**
 * Check if caffeinate is currently running
 */
export function isCaffeinateRunning(): boolean {
    return caffeinateProcess !== null && !caffeinateProcess.killed
}

/**
 * Set up cleanup handlers to ensure caffeinate is stopped on exit
 */
let cleanupHandlersSet = false

function setupCleanupHandlers(): void {
    if (cleanupHandlersSet) {
        return
    }
    
    cleanupHandlersSet = true
    
    // Clean up on various exit conditions
    const cleanup = () => {
        stopCaffeinate()
    }
    
    process.on('exit', cleanup)
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
    process.on('SIGUSR1', cleanup)
    process.on('SIGUSR2', cleanup)
    process.on('uncaughtException', (error) => {
        logger.debug('[caffeinate] Uncaught exception, cleaning up:', error)
        cleanup()
    })
    process.on('unhandledRejection', (reason, promise) => {
        logger.debug('[caffeinate] Unhandled rejection, cleaning up:', reason)
        cleanup()
    })
}