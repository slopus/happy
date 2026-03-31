/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * We only build the CLI here. Integration suites now provision their own
 * isolated environments so each suite can get a fresh lab-rat project copy.
 */

import { spawnSync } from 'node:child_process'

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'

    const buildResult = spawnSync('yarn', ['build'], { stdio: 'pipe' })
    if (buildResult.stderr && buildResult.stderr.length > 0) {
        const errorOutput = buildResult.stderr.toString()
        console.error(`Build stderr (could be debugger output): ${errorOutput}`)
        console.log(`Build stdout: ${buildResult.stdout.toString()}`)
        if (errorOutput.includes('Command failed with exit code')) {
            throw new Error(`Build failed STDERR: ${errorOutput}`)
        }
    }
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
