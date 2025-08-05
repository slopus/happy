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
  public readonly installationLocation: 'global' | 'local'
  public readonly isDaemonProcess: boolean
  
  // Directories and paths (from persistence)
  public readonly happyDir: string
  public readonly logsDir: string
  public readonly daemonLogsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonPidFile: string
  
  constructor(location: 'global' | 'local' | string, serverUrl?: string) {
    // Server configuration - priority: parameter > environment > default
    this.serverUrl = serverUrl || process.env.HANDY_SERVER_URL || 'https://handy-api.korshakov.org'
    
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start' || args[1] === 'stop')
    
    // Directory configuration (merged from persistence)
    if (location === 'local') {
      this.happyDir = join(process.cwd(), '.happy')
      this.installationLocation = 'local'
    } else if (location === 'global') {
      this.happyDir = join(homedir(), '.happy')
      this.installationLocation = 'global'
    } else {
      this.happyDir = join(location, '.happy')
      this.installationLocation = 'global' // default to global for custom paths
    }
    
    this.logsDir = join(this.happyDir, 'logs')
    this.daemonLogsDir = join(this.happyDir, 'logs-daemon')
    this.settingsFile = join(this.happyDir, 'settings.json')
    this.privateKeyFile = join(this.happyDir, 'access.key')
    this.daemonPidFile = join(this.happyDir, 'daemon.pid')
  }
}

// @ts-ignore - Intentionally undefined, will be initialized at startup
export let configuration: Configuration = undefined

export function initializeConfiguration(location: 'global' | 'local' | string, serverUrl?: string) {
  configuration = new Configuration(location, serverUrl)
}