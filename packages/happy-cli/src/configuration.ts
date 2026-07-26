/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
  public readonly attachmentsDir: string
  public readonly generatedImagesDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly sessionsFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

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
    // Staging dir for original (full-resolution) attachment bytes received from
    // the mobile client. The copy sent to the model gets downscaled by the SDK,
    // so we persist the originals here for archival (e.g. saving into Obsidian).
    this.attachmentsDir = join(this.happyHomeDir, 'attachments')
    this.generatedImagesDir = join(this.happyHomeDir, 'generated-images')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.sessionsFile = join(this.happyHomeDir, 'sessions.json')

    // 两类 URL 的优先级：HAPPY_*_URL 环境变量 > settings.<key> > 默认值。
    // 此处同步读取设置，避免与 persistence.ts 形成循环依赖。
    // webappUrl 必须与 serverUrl 使用相同的覆盖链，否则 `happy server`
    // 将 API 指向本机后，认证流程仍可能打开默认网页。
    // API 默认保留现有的 3005 直连入口；网页入口使用独立的 HTTPS 地址。
    this.serverUrl =
      process.env.HAPPY_SERVER_URL ||
      readSettingsStringSync(this.settingsFile, 'serverUrl') ||
      'http://47.115.228.20:3005'
    this.webappUrl =
      process.env.HAPPY_WEBAPP_URL ||
      readSettingsStringSync(this.settingsFile, 'webappUrl') ||
      'https://47.115.228.20:8443'

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
    if (!existsSync(this.attachmentsDir)) {
      mkdirSync(this.attachmentsDir, { recursive: true })
    }
    if (!existsSync(this.generatedImagesDir)) {
      mkdirSync(this.generatedImagesDir, { recursive: true })
    }
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
