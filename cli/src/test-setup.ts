/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'

export function setup() {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

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
