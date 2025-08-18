/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

class Configuration {
  public readonly serverUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly daemonLogsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string

  constructor() {
    // Server configuration - priority: parameter > environment > default
    this.serverUrl = process.env.HAPPY_SERVER_URL || 'https://handy-api.korshakov.org'

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start' || args[1] === 'stop')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happy')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.daemonLogsDir = join(this.happyHomeDir, 'logs-daemon')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
  }
}

export const configuration: Configuration = new Configuration()
