/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function setup() {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  // Ensure tests don't hard-fail when the default HOME isn't writable (e.g. sandboxed runners).
  const fallbackBaseDir = join(tmpdir(), `happy-coder-vitest-${process.pid}`)

  const expandHome = (value: string) => value.replace(/^~(?=\/|$)/, homedir())

  const ensureWritableDir = (dirPath: string): boolean => {
    try {
      mkdirSync(dirPath, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  const configuredHappyHomeDir = process.env.HAPPY_HOME_DIR ? expandHome(process.env.HAPPY_HOME_DIR) : ''
  const happyHomeDir =
    configuredHappyHomeDir && ensureWritableDir(join(configuredHappyHomeDir, 'logs'))
      ? configuredHappyHomeDir
      : join(fallbackBaseDir, 'happy-home')

  process.env.HAPPY_HOME_DIR = happyHomeDir
  ensureWritableDir(join(happyHomeDir, 'logs'))

  const configuredClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : ''
  const claudeConfigDir =
    configuredClaudeConfigDir && ensureWritableDir(join(configuredClaudeConfigDir, 'projects'))
      ? configuredClaudeConfigDir
      : join(fallbackBaseDir, 'claude')

  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  ensureWritableDir(join(claudeConfigDir, 'projects'))

  // Make sure to build the project before running tests
  // We rely on the dist files to spawn our CLI in integration tests
  const buildResult = spawnSync('yarn', ['build'], { stdio: 'pipe' })

  if (buildResult.stderr && buildResult.stderr.length > 0) {
    const errorOutput = buildResult.stderr.toString()
    console.error(`Build stderr (could be debugger output): ${errorOutput}`)
    const stdout = buildResult.stdout.toString()
    console.log(`Build stdout: ${stdout}`)

    if (errorOutput.includes('Command failed with exit code')) {
      throw new Error(`Build failed STDERR: ${errorOutput}`)
    }
  }
}
