/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * 1. Builds the CLI (needed for spawning in integration tests)
 * 2. Boots a full environment (server + daemon + auth) via env:up --no-switch
 * 3. Injects the environment's ports/paths into process.env
 * 4. Tears down the environment after all tests complete
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const ENVIRONMENTS_DIR = join(REPO_ROOT, '.environments')

let bootedEnvName: string | null = null

function findNewestEnvironment(): string | null {
    if (!existsSync(ENVIRONMENTS_DIR)) return null
    const entries = readdirSync(ENVIRONMENTS_DIR)
        .filter(e => {
            const envJson = join(ENVIRONMENTS_DIR, e, 'environment.json')
            return existsSync(envJson)
        })
        .map(e => ({
            name: e,
            mtime: statSync(join(ENVIRONMENTS_DIR, e, 'environment.json')).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    return entries[0]?.name ?? null
}

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'

    // Build CLI
    const buildResult = spawnSync('yarn', ['build'], { stdio: 'pipe' })
    if (buildResult.stderr && buildResult.stderr.length > 0) {
        const errorOutput = buildResult.stderr.toString()
        console.error(`Build stderr (could be debugger output): ${errorOutput}`)
        console.log(`Build stdout: ${buildResult.stdout.toString()}`)
        if (errorOutput.includes('Command failed with exit code')) {
            throw new Error(`Build failed STDERR: ${errorOutput}`)
        }
    }

    // Check if a server is already reachable (dev has env:up running manually)
    const existingUrl = process.env.HAPPY_SERVER_URL
    if (existingUrl) {
        try {
            const res = await fetch(existingUrl + '/', { signal: AbortSignal.timeout(2000) })
            if (res.ok) {
                console.log(`[test-setup] Reusing existing environment at ${existingUrl}`)
                return
            }
        } catch {
            // Not reachable, boot a new one
        }
    }

    // Boot a fresh environment
    console.log('[test-setup] Booting environment via env:up --template authenticated-empty --no-switch...')
    const upResult = spawnSync(
        'yarn',
        ['env:up', '--template', 'authenticated-empty', '--no-switch'],
        { cwd: REPO_ROOT, stdio: 'inherit', timeout: 180_000 },
    )
    if (upResult.status !== 0) {
        throw new Error(`env:up failed with exit code ${upResult.status}`)
    }

    // Find the environment that was just created (newest by mtime)
    const envName = findNewestEnvironment()
    if (!envName) {
        throw new Error('env:up succeeded but no environment found in .environments/')
    }
    bootedEnvName = envName

    const envDir = join(ENVIRONMENTS_DIR, envName)
    const config = JSON.parse(readFileSync(join(envDir, 'environment.json'), 'utf-8'))

    // Inject env vars so all tests (unit + integration) see the live environment
    process.env.HAPPY_SERVER_URL = `http://localhost:${config.serverPort}`
    process.env.HAPPY_WEBAPP_URL = `http://localhost:${config.expoPort}`
    process.env.HAPPY_HOME_DIR = join(envDir, 'cli', 'home')
    process.env.HAPPY_VARIANT = 'dev'
    process.env.DEBUG = '1'
    process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = 'true'
    process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL = '30000'
    process.env.HAPPY_DAEMON_HTTP_TIMEOUT = '60000'

    console.log(`[test-setup] Environment "${envName}" is up`)
    console.log(`  HAPPY_SERVER_URL=${process.env.HAPPY_SERVER_URL}`)
    console.log(`  HAPPY_HOME_DIR=${process.env.HAPPY_HOME_DIR}`)
}

export async function teardown() {
    if (!bootedEnvName) return

    console.log(`[test-setup] Tearing down environment "${bootedEnvName}"...`)
    spawnSync(
        'yarn',
        ['env:down', bootedEnvName],
        { cwd: REPO_ROOT, stdio: 'inherit', timeout: 30_000 },
    )
}
