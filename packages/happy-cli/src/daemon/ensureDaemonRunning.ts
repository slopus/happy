import { logger } from '@/ui/logger'
import { isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient'
import { readDaemonState } from '@/persistence'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { resolve } from 'node:path'

export async function ensureDaemonRunning(): Promise<void> {
  logger.debug('Ensuring Happy background service is running & matches our version...')

  const daemonMatchesInstalledVersion = await isDaemonRunningCurrentlyInstalledHappyVersion()
  if (daemonMatchesInstalledVersion) {
    const daemonState = await readDaemonState()
    const currentCwd = resolve(process.cwd())
    const daemonCwd = daemonState?.startedFromCwd ? resolve(daemonState.startedFromCwd) : null

    if (daemonCwd === currentCwd) {
      return
    }

    logger.debug(
      `Restarting Happy background service to adopt current working directory (daemon=${daemonCwd ?? 'unknown'}, current=${currentCwd})...`
    )

    await stopDaemon().catch((error) => {
      logger.debug('Failed to stop existing daemon before restart', error)
    })
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
