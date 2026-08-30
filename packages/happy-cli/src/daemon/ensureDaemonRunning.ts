import { logger } from '@/ui/logger'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'

const DAEMON_READY_TIMEOUT_MS = 5000
const DAEMON_READY_POLL_INTERVAL_MS = 100

export async function ensureDaemonRunning(options?: {
  startedBy?: 'daemon' | 'terminal'
}): Promise<void> {
  logger.debug('Ensuring Happy background service is running & matches our version...')

  // A daemon-spawned session already has a live parent daemon waiting for its
  // /session-started webhook. Re-running daemon discovery here can mistake a
  // temporarily busy control server for a stale daemon, remove its state/lock,
  // and start a competing daemon. The child would then report to the competitor
  // while its real parent waits until timeout.
  if (options?.startedBy === 'daemon') {
    logger.debug('Using the parent Happy background service for daemon-spawned session')
    return
  }

  if (await isDaemonRunningCurrentlyInstalledHappyVersion()) {
    return
  }

  logger.debug('Starting Happy background service...')

  const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  daemonProcess.unref()

  // Wait for the spawned daemon to be fully ready: it must write daemon.state.json,
  // bind its HTTP port, and respond to a health ping. Without this, early callers
  // (e.g. notifyDaemonSessionStarted) race the daemon startup and the webhook is
  // silently lost — which later breaks resume-happy-session.
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkIfDaemonRunningAndCleanupStaleState()) {
      logger.debug('Happy background service is ready')
      return
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS))
  }

  logger.debug(`Happy background service did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms; continuing anyway`)
}
