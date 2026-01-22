/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'

export function setup() {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  const skipBuild = (() => {
    const raw = process.env.HAPPY_CLI_TEST_SKIP_BUILD
    if (typeof raw !== 'string') return false
    return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase())
  })()

  // Make sure to build the project before running tests (opt-out).
  // We rely on the dist files to spawn our CLI in some integration tests.
  if (skipBuild) return

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
