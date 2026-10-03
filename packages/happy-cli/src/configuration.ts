/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'
import { resolveBrowserBridgeTokenFile } from './daemon/browserBridgeToken'

class Configuration {
  // serverUrl/webappUrl 은 생성 시 env>settings>default 로 정해지지만,
  // `happy auth login --server <url>` 같은 per-command override 를 위해 readonly 가 아니다.
  public serverUrl: string
  public webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly portRegistryFile: string
  public readonly browserBridgeTokenFile: string
  /** Pre-machine-wide location of the same token; adopted once, then unused. */
  public readonly legacyBrowserBridgeTokenFile: string | null
  public readonly sessionsFile: string
  public readonly automationsFile: string
  public readonly automationKeyFile: string
  public readonly serverAutomationsCacheFile: string
  public readonly serverAutomationsRuntimeFile: string
  public readonly currentCliVersion: string
  public readonly daemonHappyHomeDir: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean
  /**
   * aplus-dev-studio specs/e2ee-machine-control-boundary — whether the server
   * may hold this machine's key. Read once per process, so every check in it
   * agrees; switching takes a daemon restart.
   */
  public readonly machineControl: 'compat' | 'strict'

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

    // 신뢰 floor 가 함께 덮을 "이 프로세스가 실제로 쓰는 happy 홈".
    // 새 env 를 하나 더 만들지 않는다 — spawn 페이로드가 그 값을 정할 수 있으면
    // floor 기준을 호출자가 옮기게 된다. staged 세션 홈(/tmp/happy-session-*)은
    // 세션 자신의 자격증명이므로 제외한다. 실제 데몬 홈들은 sandboxPolicy 의
    // ~/.happy* 열거가 덮는다.
    this.daemonHappyHomeDir = this.happyHomeDir.startsWith(tmpdir())
      ? join(homedir(), '.happy')
      : this.happyHomeDir

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.portRegistryFile = join(this.happyHomeDir, 'port-registry.json')
    // Machine-wide, not HAPPY_HOME_DIR-scoped: the bridge it authenticates
    // binds one fixed port per machine (browserBridgeToken.ts).
    const bridgeToken = resolveBrowserBridgeTokenFile({ homeDir: homedir(), happyHomeDir: this.happyHomeDir })
    this.browserBridgeTokenFile = bridgeToken.tokenFile
    this.legacyBrowserBridgeTokenFile = bridgeToken.migrateFrom
    this.sessionsFile = join(this.happyHomeDir, 'sessions.json')
    this.automationsFile = join(this.happyHomeDir, 'automations.json')
    this.automationKeyFile = join(this.happyHomeDir, 'automation-key.v1.json')
    this.serverAutomationsCacheFile = join(this.happyHomeDir, 'server-automations.v1.json')
    this.serverAutomationsRuntimeFile = join(this.happyHomeDir, 'server-automations-runtime.v1.json')

    // URL precedence (both): HAPPY_*_URL env > settings.<key> > default.
    // Settings are read sync here (avoid circular import with persistence.ts).
    // webappUrl must follow the same chain as serverUrl, otherwise `happy server`
    // self-host points the API at localhost but auth still opens the prod webapp.
    this.serverUrl =
      process.env.HAPPY_SERVER_URL ||
      readSettingsStringSync(this.settingsFile, 'serverUrl') ||
      'https://saycode.ai'
    this.webappUrl =
      process.env.HAPPY_WEBAPP_URL ||
      readSettingsStringSync(this.settingsFile, 'webappUrl') ||
      this.serverUrl ||
      'https://saycode.ai'

    // HAPPY_MACHINE_CONTROL=strict runs a process strict whatever its settings say, for a happy
    // home without settings.json. The variable can only raise compat to strict, never lower it.
    this.machineControl = readSettingsStringSync(this.settingsFile, 'machineControl') === 'strict'
      || process.env.HAPPY_MACHINE_CONTROL === 'strict'
      ? 'strict'
      : 'compat'

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    if (!existsSync(this.happyHomeDir)) {
      // Owner-only: the home holds key material (specs/e2ee-machine-control-boundary R9).
      mkdirSync(this.happyHomeDir, { recursive: true, mode: 0o700 })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }

  /**
   * Per-command relay override, e.g. `happy auth login --server <url>` (standalone
   * zrok URL). serverUrl 과 webappUrl 을 함께 맞춰 /v1/auth/request 와 승인 URL 이 같은
   * 릴레이를 가리키게 한다. 빈 문자열은 무시. 후행 슬래시 제거.
   */
  applyRelayOverride(url: string): void {
    const trimmed = url.trim().replace(/\/+$/, '')
    if (!trimmed) return
    this.serverUrl = trimmed
    this.webappUrl = trimmed
  }
}

function readSettingsStringSync(settingsFile: string, key: 'serverUrl' | 'webappUrl' | 'machineControl'): string | undefined {
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
