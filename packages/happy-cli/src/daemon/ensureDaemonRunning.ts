import { logger } from '@/ui/logger'
import { isDaemonRunningCurrentlyInstalledHappyVersion, waitForDaemonReady } from './controlClient'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'

export async function ensureDaemonRunning(): Promise<void> {
  logger.debug('Ensuring Happy background service is running & matches our version...')

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

  const started = await waitForDaemonReady()
  if (!started) {
    throw new Error('Happy daemon failed to become ready')
  }
}
