/**
 * Test setup file for vitest
 * 
 * Configures the test environment before running tests
 */

// Extend test timeout for integration tests
process.env.VITEST_POOL_TIMEOUT = '60000'

// Make sure to build the project before running tests
// We rely on the dist files to spawn our CLI in integration tests
import { spawnSync } from 'node:child_process'

const buildResult = spawnSync('yarn', ['build'], { stdio: 'pipe' })
if (buildResult.stderr && buildResult.stderr.length > 0) {
  const errorOutput = buildResult.stderr.toString()
  console.error(`Build stderr (could be debugger output): ${errorOutput}`)
  console.log(buildResult.stdout.toString())
}
