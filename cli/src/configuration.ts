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
  
  // Directories and paths (from persistence)
  public readonly happyDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  
  constructor(location: 'global' | 'local') {
    // Server configuration from environment
    this.serverUrl = process.env.HANDY_SERVER_URL || 'https://handy-api.korshakov.org'
    
    // Directory configuration (merged from persistence)
    if (location === 'local') {
      this.happyDir = join(process.cwd(), '.happy')
    } else {
      this.happyDir = join(homedir(), '.happy')
    }
    
    this.logsDir = join(this.happyDir, 'logs')
    this.settingsFile = join(this.happyDir, 'settings.json')
    this.privateKeyFile = join(this.happyDir, 'access.key')
  }
}

// @ts-ignore - Intentionally undefined, will be initialized at startup
export let configuration: Configuration = undefined

export function initializeConfiguration(location: 'global' | 'local') {
  configuration = new Configuration(location)
}