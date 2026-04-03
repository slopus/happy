import { logger } from '@/ui/logger'
import { isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient'
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

  // Give daemon a moment to write PID & port file before first notification.
  await new Promise(resolve => setTimeout(resolve, 200))
}
