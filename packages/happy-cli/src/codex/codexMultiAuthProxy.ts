import { isSupportedCodexMultiAuthVersion, SUPPORTED_CODEX_MULTI_AUTH_VERSIONS } from '../utils/codexMultiAuthVersions'
import { randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const QUOTA_REMAINING_THRESHOLD = 5
const PROVIDER_ID = 'codex-multi-auth-runtime-proxy'
const execFile = promisify(execFileCallback)

type ProxyServer = { baseUrl: string; close(): Promise<void> }

type ProxyDependencies = {
  readFile(path: string): Promise<string>
  startProxy(options: {
    clientApiKey: string
    quotaRemainingPercentThreshold: number
  }): Promise<ProxyServer>
  createClientKey(): string
}

export type PreparedCodexMultiAuthProxy = {
  args: string[]
  env: Record<string, string>
  cleanup(): Promise<void>
}

let activeRoutes = 0

export function getCodexMultiAuthProxyStatus(): { activeRoutes: number } {
  return { activeRoutes }
}

export async function prepareCodexMultiAuthProxy(
  environment: Record<string, string | undefined>,
  overrides: Partial<ProxyDependencies> = {},
): Promise<PreparedCodexMultiAuthProxy | null> {
  const deps: ProxyDependencies = {
    readFile: (path) => readFile(path, 'utf8'),
    startProxy: startSupportedRuntimeRotationProxy,
    createClientKey: () => randomBytes(32).toString('base64url'),
    ...overrides,
  }
  const codexHome = nonEmpty(environment.CODEX_HOME) ?? join(homedir(), '.codex')
  const multiAuthDir = nonEmpty(environment.CODEX_MULTI_AUTH_DIR) ?? join(codexHome, 'multi-auth')
  let content: string
  try {
    content = await deps.readFile(join(multiAuthDir, 'settings.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Managed Codex rotation settings are unavailable')
  }
  let settings: unknown
  try {
    settings = JSON.parse(content)
  } catch {
    throw new Error('Managed Codex rotation settings are invalid')
  }
  if (!isManagedRotationRequested(settings)) return null
  if (!isManagedCodexRotationSettings(settings)) {
    throw new Error('Managed Codex rotation settings do not match the required 5% policy')
  }

  const clientApiKey = deps.createClientKey()
  const proxy = await deps.startProxy({
    clientApiKey,
    quotaRemainingPercentThreshold: QUOTA_REMAINING_THRESHOLD,
  })
  activeRoutes += 1
  let cleaned = false
  return {
    args: runtimeProviderArgs(proxy.baseUrl),
    env: Object.fromEntries(Object.entries({
      ...environment,
      CODEX_HOME: codexHome,
      CODEX_MULTI_AUTH_DIR: multiAuthDir,
      OPENAI_API_KEY: clientApiKey,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      try {
        await proxy.close()
      } finally {
        activeRoutes = Math.max(0, activeRoutes - 1)
      }
    },
  }
}

async function startSupportedRuntimeRotationProxy(options: {
  clientApiKey: string
  quotaRemainingPercentThreshold: number
}): Promise<ProxyServer> {
  const { stdout } = await execFile('npm', ['root', '--global'])
  const globalRoot = nonEmpty(stdout)
  if (!globalRoot) throw new Error('npm global package root is unavailable')
  const packageRoot = join(globalRoot, 'codex-multi-auth')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown
  if (!isObject(packageJson) || !isSupportedCodexMultiAuthVersion(packageJson.version)) {
    throw new Error(`Unsupported codex-multi-auth version ${isObject(packageJson) && typeof packageJson.version === 'string' && /^\d+\.\d+\.\d+$/.test(packageJson.version) ? packageJson.version : 'unknown'}; supported: ${SUPPORTED_CODEX_MULTI_AUTH_VERSIONS.join(', ')}`)
  }
  const moduleUrl = pathToFileURL(join(
    packageRoot,
    'dist',
    'lib',
    'runtime-rotation-proxy.js',
  )).href
  // The companion module must be loaded from npm's global root, not bundled.
  const importModule = Function('moduleUrl', 'return import(moduleUrl)') as (url: string) => Promise<{
    startRuntimeRotationProxy(value: typeof options): Promise<ProxyServer>
  }>
  const runtimeModule = await importModule(moduleUrl)
  return runtimeModule.startRuntimeRotationProxy(options)
}

function runtimeProviderArgs(baseUrl: string): string[] {
  const provider = `model_providers.${PROVIDER_ID}`
  return [
    '-c', `${provider}.name="Codex multi-auth"`,
    '-c', `${provider}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `${provider}.env_key="OPENAI_API_KEY"`,
    '-c', `${provider}.requires_openai_auth=false`,
    '-c', `${provider}.wire_api="responses"`,
    '-c', 'disable_response_storage=false',
    '-c', `model_provider="${PROVIDER_ID}"`,
  ]
}

export function isManagedCodexRotationSettings(value: unknown): boolean {
  if (!isObject(value) || value.version !== 1 || !isObject(value.pluginConfig)) return false
  return value.pluginConfig.codexRuntimeRotationProxy === true
    && value.pluginConfig.schedulingStrategy === 'sequential'
    && value.pluginConfig.preemptiveQuotaEnabled === true
    && value.pluginConfig.preemptiveQuotaRemainingPercent5h === QUOTA_REMAINING_THRESHOLD
    && value.pluginConfig.preemptiveQuotaRemainingPercent7d === QUOTA_REMAINING_THRESHOLD
    && value.pluginConfig.routingMutex === 'enabled'
    && value.pluginConfig.sessionAffinity === false
    && value.pluginConfig.pidOffsetEnabled === false
}

function isManagedRotationRequested(value: unknown): boolean {
  return isObject(value)
    && isObject(value.pluginConfig)
    && value.pluginConfig.codexRuntimeRotationProxy === true
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
