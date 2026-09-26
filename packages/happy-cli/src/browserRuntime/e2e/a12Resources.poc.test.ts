import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ActionId, RequestId, StepId, TabId } from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { PROFILE_A, SITE_A, startPocStack, type PocStack } from './pocStack'
import { a12Grant } from './a12Helpers'

const rid = () => randomUUID() as RequestId
const repeat = Number(process.env.ABP_REPEAT ?? 3)
const cycles = Number(process.env.ABP_CYCLES ?? 100)
const targets = (container: string) => JSON.parse(execFileSync('docker', ['exec', container, 'python3', '-c', "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:9222/json/list').read().decode())"], { encoding: 'utf8' })) as Array<{ id: string; type: string }>
const pageTargets = (container: string) => targets(container).filter(t => t.type === 'page').map(t => t.id)
const counts = async (stack: PocStack) => (await stack.admin<{ drivers: Record<string, { counts: { tabs: number; sessions: number } }> }>('/admin/debug')).drivers[PROFILE_A].counts
const rejectCode = async (promise: Promise<unknown>, code: string | string[]) => {
    try { await promise; throw new Error(`A12 expected ${code}, operation succeeded`) }
    catch (e) { if (!(Array.isArray(code) ? code : [code]).includes((e as { code?: string }).code ?? '')) throw e }
}

describe('A12 real stack resource cycle', () => {

    it.each(Array.from({ length: repeat }, (_, i) => i))('100 cycles with two long-lived spaces, repetition %i', async (round) => {
        const started = Date.now()
        const stack: PocStack = await startPocStack()
        try {
        const minted = { token: a12Grant(stack) }
        console.log(JSON.stringify({ evidence: { card: 'A12', path: 'clock', run: stack.run, hostNowMs: Date.now(), browserNowMs: Number(execFileSync('docker', ['exec', stack.env.containers.runtime, 'date', '+%s%3N'], { encoding: 'utf8' })) } }))
        const client = stack.client(minted.token)
        const [s1, s2] = await Promise.all([client.createSpace({ profileId: PROFILE_A, requestId: rid() }), client.createSpace({ profileId: PROFILE_A, requestId: rid() })])
        const baseline = await counts(stack)
        const browser = stack.env.containers.browserA
        const baselineTargets = pageTargets(browser)
        let clicks = 0
        for (let i = 0; i < cycles; i++) {
            const space = i % 2 ? s2.taskSpaceId : s1.taskSpaceId
            const other = i % 2 ? s1.taskSpaceId : s2.taskSpaceId
            const task = await client.createTask({ taskSpaceId: space, requestId: rid() })
            const opened = await client.openPage({ taskId: task.taskId, url: `${SITE_A}/oopif?run=${stack.run}`, requestId: rid() })
            const observed = await client.observe({ taskId: task.taskId, tabId: opened.tabId })
            const button = observed.elements.find(e => e.name === 'Buy' && e.frameOrigin === SITE_A)
            expect(button, `A12 cycle ${i}: main-frame Buy absent`).toBeDefined()
            if (i === 0) {
                await rejectCode(client.closePage({ taskSpaceId: other, tabId: opened.tabId, requestId: rid() }), ['SCOPE_DENIED', 'CONFLICT'])
                await rejectCode(client.closePage({ taskSpaceId: space, tabId: opened.tabId, requestId: rid() }), 'CONFLICT')
            }
            const submitted = await client.submitBatch({ taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [{ stepId: `step-${round}-${i}` as StepId, actionId: `action-${round}-${i}` as ActionId, tabId: opened.tabId as TabId, kind: 'click', ref: button!.ref, timeoutMs: 10_000 }] }, { waitMs: 30_000 })
            expect(submitted.result?.outcome, `A12 cycle ${i}: action outcome`).toBe('succeeded')
            const finished = await client.finishTask({ taskId: task.taskId, expectedVersion: submitted.task.stateVersion, requestId: rid() })
            expect(finished.status).toBe('succeeded')
            const closeRequest = { taskSpaceId: space, tabId: opened.tabId, requestId: rid() }
            if (i === 0) {
                const lostAck = new RuntimeClient({ baseUrl: stack.runtimeUrl, token: minted.token, fetchImpl: async (...args) => { const response = await fetch(...args); await response.arrayBuffer(); throw new Error('injected ACK loss after closePage response') } })
                await rejectCode(lostAck.closePage(closeRequest), 'RUNTIME_UNAVAILABLE')
            }
            const first = await client.closePage(closeRequest)
            expect(first).toEqual({ closed: true })
            if (i === 0) expect(await client.closePage(closeRequest), 'A12 closePage ACK-loss retry must return identical result').toEqual(first)
            clicks++
            if ((i + 1) % 10 === 0) console.log(JSON.stringify({ evidence: { card: 'A12', path: 'cycle-progress', round, cycles: i + 1, run: stack.run, elapsedMs: Date.now() - started } }))
        }
        const ledger = await stack.waitForLedger(entries => entries.filter(e => e.kind === 'click' && e.target === 'A-main').length >= clicks)
        expect(ledger.filter(e => e.kind === 'click' && e.target === 'A-main')).toHaveLength(clicks)
        const after = await counts(stack)
        expect(after, 'A12 driver tab/session registry must return to baseline').toEqual(baseline)
        const finalTargets = pageTargets(browser)
        expect(finalTargets, 'A12 browser CDP page targets must return to baseline').toEqual(baselineTargets)
        const beforeTask = await client.createTask({ taskSpaceId: s1.taskSpaceId, requestId: rid() })
        const beforeOpen = await client.openPage({ taskId: beforeTask.taskId, url: `${SITE_A}/beforeunload`, requestId: rid() })
        const beforeObservation = await client.observe({ taskId: beforeTask.taskId, tabId: beforeOpen.tabId })
        const arm = beforeObservation.elements.find(e => e.name === 'Arm')
        expect(arm, 'A12 beforeunload Arm button missing').toBeDefined()
        const armed = await client.submitBatch({ taskId: beforeTask.taskId, expectedVersion: beforeOpen.task.stateVersion, requestId: rid(), steps: [{ stepId: `arm-${round}` as StepId, actionId: `arm-action-${round}` as ActionId, tabId: beforeOpen.tabId, kind: 'click', ref: arm!.ref, timeoutMs: 10_000 }] }, { waitMs: 30_000 })
        expect(armed.result?.outcome).toBe('succeeded')
        await client.finishTask({ taskId: beforeTask.taskId, expectedVersion: armed.task.stateVersion, requestId: rid() })
        const handoff = await client.closePage({ taskSpaceId: s1.taskSpaceId, tabId: beforeOpen.tabId, requestId: rid() })
        expect(handoff, 'A12 beforeunload must hand off instead of force closing').toEqual({ closed: false, handoff: 'beforeunload' })
        console.log(JSON.stringify({ evidence: { card: 'A12', path: 'beforeunload', round, run: stack.run, handoff: handoff.handoff } }))
        console.log(JSON.stringify({ evidence: { card: 'A12', path: 'cycle', round, run: stack.run, cycles, clicks, ackLossRetries: 1, runningCloseRejections: 1, baseline, after, baselineTargetCount: baselineTargets.length, finalTargetCount: finalTargets.length, elapsedMs: Date.now() - started } }))
        } finally { stack.down({ purge: true }) }
    }, 1_200_000)
    it.each(Array.from({ length: repeat }, (_, i) => i))('rejects other-space close after owner task finishes, repetition %i', async (round) => {
        const stack = await startPocStack()
        try {
            const client = stack.client(a12Grant(stack))
            const own = await client.createSpace({ profileId: PROFILE_A, requestId: rid() })
            const other = await client.createSpace({ profileId: PROFILE_A, requestId: rid() })
            const task = await client.createTask({ taskSpaceId: own.taskSpaceId, requestId: rid() })
            const opened = await client.openPage({ taskId: task.taskId, url: `${SITE_A}/marker?label=a12`, requestId: rid() })
            await client.finishTask({ taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: rid() })
            await rejectCode(client.closePage({ taskSpaceId: other.taskSpaceId, tabId: opened.tabId, requestId: rid() }), ['SCOPE_DENIED', 'TARGET_GONE', 'CONFLICT'])
            expect(await client.closePage({ taskSpaceId: own.taskSpaceId, tabId: opened.tabId, requestId: rid() })).toEqual({ closed: true })
            console.log(JSON.stringify({ evidence: { card: 'A12', path: 'cross-space-close', round, run: stack.run, rejected: true } }))
        } finally { stack.down({ purge: true }) }
    }, 300_000)
})
