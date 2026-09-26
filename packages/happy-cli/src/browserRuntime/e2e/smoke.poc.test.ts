import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionId, RequestId, StepId, TabId } from '../contracts'
import { PROFILE_A, SITE_A, startPocStack, type PocStack } from './pocStack'

const rid = () => randomUUID() as RequestId

describe('PoC stack smoke', () => {
    let stack: PocStack
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it('runs createTask → openPage → batch → finishTask on the containerised browser', async () => {
        const { token } = stack.mintAgent()
        const client = stack.client(token)
        const { taskSpaceId } = await client.createSpace({ profileId: PROFILE_A, requestId: rid() })
        const task = await client.createTask({ taskSpaceId, requestId: rid() })
        const opened = await client.openPage({ taskId: task.taskId, url: `${SITE_A}/oopif?run=${stack.run}`, requestId: rid() })
        const observation = await client.observe({ taskId: task.taskId, tabId: opened.tabId })
        const buy = observation.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)
        expect(buy).toBeDefined()
        const submitted = await client.submitBatch({
            taskId: task.taskId,
            expectedVersion: opened.task.stateVersion,
            requestId: rid(),
            steps: [{ stepId: 's1' as StepId, actionId: 'a1' as ActionId, tabId: opened.tabId as TabId, kind: 'click', ref: buy!.ref, timeoutMs: 10_000 }],
        }, { waitMs: 30_000 })
        expect(submitted.result?.outcome).toBe('succeeded')
        const finished = await client.finishTask({ taskId: task.taskId, expectedVersion: submitted.task.stateVersion, requestId: rid() })
        expect(finished.status).toBe('succeeded')
        const ledger = await stack.waitForLedger((entries) => entries.some((entry) => entry.kind === 'click'))
        expect(ledger.filter((entry) => entry.kind === 'click').map((entry) => entry.target)).toEqual(['A-main'])
    }, 120_000)
})
