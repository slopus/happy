/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly legacyDaemonStateFile: string
  public readonly daemonLockFile: string
  public readonly sessionsFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean
  public readonly bootHappyAgent: boolean

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happy')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.legacyDaemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.control.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.sessionsFile = join(this.happyHomeDir, 'sessions.json')

    mkdirSync(this.happyHomeDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      const dir = statSync(this.happyHomeDir)
      const dedicatedHome = !process.env.HAPPY_HOME_DIR && !lstatSync(this.happyHomeDir).isSymbolicLink()
      if (dir.uid !== process.getuid!() || (!dedicatedHome && (dir.mode & 0o022))) {
        console.warn(`Happy home ${this.happyHomeDir} may be writable by other users. Use a private HAPPY_HOME_DIR or chmod go-w on your own dedicated directory.`)
      } else if (dedicatedHome && (dir.mode & 0o777) !== 0o700) {
        try { chmodSync(this.happyHomeDir, 0o700) } catch { console.warn(`Could not tighten Happy home permissions: ${this.happyHomeDir}`) }
      }
      for (const path of [this.privateKeyFile, this.daemonStateFile, this.legacyDaemonStateFile, this.sessionsFile, this.settingsFile,
        this.sessionsFile + '.tmp', this.settingsFile + '.tmp', this.daemonLockFile, this.settingsFile + '.lock']) {
        protectExistingFile(path)
      }
    }

    // URL precedence (both): HAPPY_*_URL env > settings.<key> > default.
    // Settings are read sync here (avoid circular import with persistence.ts).
    // webappUrl must follow the same chain as serverUrl, otherwise `happy server`
    // self-host points the API at localhost but auth still opens the prod webapp.
    this.serverUrl =
      process.env.HAPPY_SERVER_URL ||
      readSettingsStringSync(this.settingsFile, 'serverUrl') ||
      'https://api.cluster-fluster.com'
    this.webappUrl =
      process.env.HAPPY_WEBAPP_URL ||
      readSettingsStringSync(this.settingsFile, 'webappUrl') ||
      'https://app.happy.engineering'

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');
    // Happy Agent is a second machine-level daemon with its own database and its own
    // registration on the Happy account, so starting it is opted into rather than
    // inherited by everyone who upgrades the CLI.
    this.bootHappyAgent =
      ['true', '1', 'yes'].includes(process.env.HAPPY_BOOT_AGENT?.toLowerCase() || '') ||
      this.isExperimentalEnabled;

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true, mode: 0o700 })
    }
  }
}

function protectExistingFile(path: string) {
  let fd: number | undefined
  try {
    // Use the checked descriptor, not a path that another directory writer could replace.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const file = fstatSync(fd)
    if (!file.isFile() || file.uid !== process.getuid!() || file.nlink !== 1) throw new Error()
    if ((file.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Could not safely tighten Happy state permissions: ${path}. Use a private, user-owned regular file.`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readSettingsStringSync(settingsFile: string, key: 'serverUrl' | 'webappUrl'): string | undefined {
  try {
    if (!existsSync(settingsFile)) return undefined
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
    const value = raw?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export const configuration: Configuration = new Configuration()
