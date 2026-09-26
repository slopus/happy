import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RequestId } from '../contracts'
import { PROFILE_A, startPocStack } from './pocStack'
import { a12Grant } from './a12Helpers'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const rid = () => randomUUID() as RequestId

describe('A12 rollback', () => {
    it('fences a live task and preserves the run-owned profile volume', async () => {
        const stack = await startPocStack()
        try {
            const client = stack.client(a12Grant(stack))
            const space = await client.createSpace({ profileId: PROFILE_A, requestId: rid() })
            const task = await client.createTask({ taskSpaceId: space.taskSpaceId, requestId: rid() })
            const output = execFileSync('node', [join(packageDir, 'scripts/browser-poc/rollback.mjs'), '--run', stack.run], { cwd: packageDir, encoding: 'utf8', timeout: 120_000 })
            const report = JSON.parse(output) as { cancelled: string[]; runtimeStopped: boolean; canaryVerified: boolean; cleanup: boolean; viewerAvailable: boolean }
            expect(report.cancelled).toContain(task.taskId)
            expect(report.runtimeStopped).toBe(true)
            expect(report.canaryVerified).toBe(true)
            expect(report.cleanup).toBe(true)
            expect(report.viewerAvailable).toBe(true)
            const again = JSON.parse(execFileSync('node', [join(packageDir, 'scripts/browser-poc/rollback.mjs'), '--run', stack.run], { cwd: packageDir, encoding: 'utf8', timeout: 30_000 })) as typeof report
            expect(again).toEqual(report)
            console.log(JSON.stringify({ evidence: { card: 'A12', path: 'rollback', run: stack.run, taskId: task.taskId, cancelledCount: report.cancelled.length, runtimeStopped: report.runtimeStopped, canaryVerified: report.canaryVerified, cleanup: report.cleanup, viewerAvailable: report.viewerAvailable } }))
        } finally { stack.down({ purge: true }) }
    }, 300_000)
})
