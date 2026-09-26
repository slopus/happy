import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startPocStack } from './pocStack'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = (name: string, args: string[], timeout: number) => JSON.parse(execFileSync('node', [join(packageDir, 'scripts/browser-poc', name), ...args], { cwd: packageDir, encoding: 'utf8', timeout })) as Record<string, unknown>

describe('A12 real stack soak and rollback', () => {
    it('samples bounded work and preserves profile volume on rollback', async () => {
        const stack = await startPocStack()
        const minutes = Number(process.env.ABP_SOAK_MINUTES ?? 30)
        const warmup = Number(process.env.ABP_SOAK_WARMUP_MINUTES ?? 5)
        try {
            const soak = script('soak.mjs', ['--run', stack.run, '--minutes', String(minutes), '--warmup-minutes', String(warmup)], (minutes + warmup + 5) * 60_000)
            console.log(JSON.stringify({ evidence: { card: 'A12', path: 'soak', run: stack.run, minutes, warmup, completed: soak.completed, crashes: soak.crashes, taskLoss: soak.taskLoss, result: soak.result } }))
            expect(soak.pass, 'A12 soak RSS/crash/task-loss acceptance rule').toBe(true)
            const rollback = script('rollback.mjs', ['--run', stack.run], 120_000)
            console.log(JSON.stringify({ evidence: { card: 'A12', path: 'rollback', run: stack.run, cancelledCount: (rollback.cancelled as unknown[]).length, runtimeStopped: rollback.runtimeStopped, canaryVerified: rollback.canaryVerified, cleanup: rollback.cleanup } }))
            expect(rollback.runtimeStopped).toBe(true)
            expect(rollback.canaryVerified).toBe(true)
            expect(rollback.cleanup).toBe(true)
            expect(rollback.viewerAvailable).toBe(true)
        } finally { stack.down({ purge: true }) }
    }, 2_400_000)
})
