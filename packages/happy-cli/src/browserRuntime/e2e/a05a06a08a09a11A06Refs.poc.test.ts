/**
 * A06 — snapshot / ref / iframe / screenshot, through the Runtime (not the
 * driver directly). Source: Saydo specs/agent-browser-poc/acceptance.md A06.
 *
 * Every path runs ABP_REPEAT (default 10) times. Wrong-target clicks are
 * counted from the fixture ledger, namespaced per iteration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchResult, ElementRef, TaskId } from '../contracts'
import type { RuntimeClient } from '../runtimeClient'
import {
    activateTargetAsUser, cleanupSpace, client, count, decodePng, evidence, ledgerRun, mintAgent, newTaskWithPage,
    observeUntil, pageUrl, range, releaseBarrier, repeat, rid, settledLedger, step, waitLedger,
} from './a05a06a08a09a11Helpers'
import { SITE_A, SITE_B, startPocStack, type PocStack } from './pocStack'

const N = repeat(10)

async function batch(c: RuntimeClient, taskId: TaskId, version: number, steps: Parameters<typeof step>[]): Promise<{ result: BatchResult; version: number }> {
    const submitted = await c.submitBatch({ taskId, expectedVersion: version, requestId: rid(), steps: steps.map((s) => step(...s)) }, { waitMs: 60_000 })
    expect(submitted.result, 'batch did not reach a stopping point within 60 s').toBeDefined()
    return { result: submitted.result!, version: submitted.task.stateVersion }
}

const failedCode = (result: BatchResult): string | undefined => result.steps.find((s) => s.error)?.error?.code

describe('A06 snapshot/ref/iframe/screenshot via Runtime', () => {
    let stack: PocStack
    let c: RuntimeClient
    beforeAll(async () => {
        stack = await startPocStack()
        c = client(stack, mintAgent(stack).token)
    }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it.each(range(N))('OOPIF frame-qualified ref and open shadow DOM hit only the chosen button #%i', async (i) => {
        const L = ledgerRun(stack, `a06-oopif-${i}`)
        const t = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/oopif', {}, L))
        try {
            const o = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const bFrame = o.frames.find((f) => f.origin === SITE_B)
            expect(bFrame?.outOfProcess, 'site B iframe must be an OOPIF (separate CDP target)').toBe(true)
            const buys = o.elements.filter((e) => e.name === 'Buy')
            const bRef = buys.find((e) => e.frameOrigin === SITE_B)!.ref
            const aRefs = buys.filter((e) => e.frameOrigin === SITE_A).map((e) => e.ref)
            expect(aRefs).toHaveLength(2)
            expect(bRef.startsWith('@f')).toBe(true)

            let v = t.version
            const r1 = await batch(c, t.taskId, v, [[t.tabId, 'click', { ref: bRef, snapshotId: o.snapshotId }]])
            v = r1.version
            expect(r1.result.outcome).toBe('succeeded')
            let ledger = await waitLedger(stack, L, (e) => count(e, 'click') >= 1)
            expect(ledger.filter((e) => e.kind === 'click').map((e) => e.target)).toEqual(['B-frame'])

            const targets: unknown[] = []
            for (const ref of aRefs) {
                const r = await batch(c, t.taskId, v, [[t.tabId, 'click', { ref, snapshotId: o.snapshotId }]])
                v = r.version
                expect(r.result.outcome).toBe('succeeded')
                ledger = await waitLedger(stack, L, (e) => count(e, 'click') >= 2 + targets.length)
                targets.push(ledger.filter((e) => e.kind === 'click').at(-1)!.target)
            }
            expect(new Set(targets), 'the two same-label site-A refs must hit main and shadow buttons respectively').toEqual(new Set(['A-main', 'A-shadow']))
            ledger = await settledLedger(stack, L, 500)
            expect(count(ledger, 'click')).toBe(3)
            expect(count(ledger, 'click', { target: 'B-frame' })).toBe(1)
            evidence('A06', { path: 'oopif-shadow', i, bRef, aRefs, oopif: bFrame?.outOfProcess, clicks: ledger.map((e) => e.target) })
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('SPA swap after snapshot: stale ref fails with STALE_REF and the decoy is never clicked #%i', async (i) => {
        const L = ledgerRun(stack, `a06-spa-${i}`)
        const t = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/x5/spa', { key: 'swap', mode: 'swap' }, L))
        try {
            const before = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const target = before.elements.find((e) => e.name === 'Target')
            expect(target, 'snapshot must be taken before the swap').toBeDefined()
            await releaseBarrier(stack, L, 'swap', `n${i}`)
            // Sync on the fixture ledger, not on a new observe (that would become the latest agent-visible snapshot).
            await waitLedger(stack, L, (e) => count(e, 'click', { target: 'spa-swapped' }) >= 1, { settleMs: 0 })
            const r = await batch(c, t.taskId, t.version, [[t.tabId, 'click', { ref: target!.ref, snapshotId: before.snapshotId }]])
            const ledger = await settledLedger(stack, L, 1_000)
            evidence('A06', { path: 'spa-swap', i, outcome: r.result.outcome, code: failedCode(r.result), decoyClicks: count(ledger, 'click', { target: 'decoy' }), targetClicks: count(ledger, 'click', { target: 'target' }) })
            expect(count(ledger, 'click', { target: 'decoy' }), 'CONTRACT: a ref from the pre-swap snapshot must never click the replacement (decoy) button').toBe(0)
            expect(r.result.outcome).not.toBe('succeeded')
            expect(failedCode(r.result), 'CONTRACT: stale ref must end as STALE_REF').toBe('STALE_REF')
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('SPA swap triggered by the click pointer move: decoy never clicked #%i', async (i) => {
        const L = ledgerRun(stack, `a06-spamove-${i}`)
        const t = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/x5/spa', { key: 'arm', mode: 'hover' }, L))
        try {
            const before = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const target = before.elements.find((e) => e.name === 'Target')
            expect(target, 'snapshot must be taken before arming the hover swap').toBeDefined()
            await releaseBarrier(stack, L, 'arm', `n${i}`)
            await waitLedger(stack, L, (e) => count(e, 'click', { target: 'spa-armed' }) >= 1, { settleMs: 0 })
            const r = await batch(c, t.taskId, t.version, [[t.tabId, 'click', { ref: target!.ref, snapshotId: before.snapshotId }]])
            const ledger = await settledLedger(stack, L, 1_000)
            evidence('A06', { path: 'spa-pointermove-swap', i, outcome: r.result.outcome, code: failedCode(r.result), decoyClicks: count(ledger, 'click', { target: 'decoy' }), targetClicks: count(ledger, 'click', { target: 'target' }) })
            expect(count(ledger, 'click', { target: 'decoy' }), 'CONTRACT: node swapped during input must not receive the click').toBe(0)
            expect(count(ledger, 'click', { target: 'target' })).toBe(0)
            expect(failedCode(r.result)).toBe('STALE_REF')
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('navigation invalidates refs from the previous document #%i', async (i) => {
        const L = ledgerRun(stack, `a06-nav-${i}`)
        const url = pageUrl(stack, SITE_A, '/oopif', {}, L)
        const t = await newTaskWithPage(c, url)
        try {
            const before = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const oldRef = before.elements.find((e) => e.frameOrigin === SITE_A && e.name === 'Buy')!.ref
            // Same URL again: the new document has an element at the same ref position.
            const r = await batch(c, t.taskId, t.version, [[t.tabId, 'navigate', { url }], [t.tabId, 'click', { ref: oldRef, snapshotId: before.snapshotId }]])
            const ledger = await settledLedger(stack, L, 1_000)
            evidence('A06', { path: 'navigation-stale-ref', i, outcome: r.result.outcome, code: failedCode(r.result), clicks: count(ledger, 'click') })
            expect(count(ledger, 'click'), 'CONTRACT: a ref observed before navigation must not click in the new document').toBe(0)
            expect(failedCode(r.result)).toBe('STALE_REF')
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('frame detach/re-attach invalidates the old frame ref #%i', async (i) => {
        const L = ledgerRun(stack, `a06-reattach-${i}`)
        const t = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/x5/frame-reattach', { key: 'swap' }, L))
        try {
            const before = await c.observe({ taskId: t.taskId, tabId: t.tabId })
            const oldRef = before.elements.find((e) => e.frameOrigin === SITE_B)!.ref
            await releaseBarrier(stack, L, 'swap', 'go')
            await waitLedger(stack, L, (e) => count(e, 'click', { target: 'frame-reattached' }) >= 1, { settleMs: 0 })
            const r = await batch(c, t.taskId, t.version, [[t.tabId, 'click', { ref: oldRef, snapshotId: before.snapshotId }]])
            const ledger = (await settledLedger(stack, L, 1_000)).filter((e) => e.target !== 'frame-reattached')
            // Observing the re-attached frame afterwards must work too (the agent's next step).
            const after = await observeUntil(c, t.taskId, t.tabId, (o) => o.elements.some((e) => e.frameOrigin === SITE_B))
            evidence('A06', { path: 'frame-reattach', i, oldRef, newRef: after.elements.find((e) => e.frameOrigin === SITE_B)?.ref, code: failedCode(r.result), clicks: count(ledger, 'click') })
            expect(count(ledger, 'click'), 'old frame ref must not click the re-attached frame').toBe(0)
            expect(failedCode(r.result)).toBe('STALE_REF')
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('screenshot returns the agent background tab, not the tab the user has in front #%i', async (i) => {
        const user = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/marker', { color: '00ff00', label: `USER${i}` }))
        const agent = await newTaskWithPage(c, pageUrl(stack, SITE_A, '/marker', { color: 'ff0000', label: `AGENT${i}` }), { taskSpaceId: user.taskSpaceId })
        try {
            const userShot = await c.screenshot({ taskId: user.taskId, tabId: user.tabId })
            activateTargetAsUser(stack, 'a', userShot.targetId)
            const shot = await c.screenshot({ taskId: agent.taskId, tabId: agent.tabId })
            const png = decodePng(shot.data)
            const corner = png.pixel(5, 5)
            const userPng = decodePng((await c.screenshot({ taskId: user.taskId, tabId: user.tabId })).data)
            evidence('A06', { path: 'background-screenshot', i, agentTarget: shot.targetId, userTarget: userShot.targetId, agentPixel: corner, userPixel: userPng.pixel(5, 5), size: [png.width, png.height] })
            expect(shot.targetId).not.toBe(userShot.targetId)
            expect(shot.tabId).toBe(agent.tabId)
            expect(corner, 'agent screenshot must show its own red marker').toEqual([255, 0, 0])
            expect(userPng.pixel(5, 5)).toEqual([0, 255, 0])
        } finally {
            expect(await cleanupSpace(stack, c, user.taskSpaceId, [user.taskId, agent.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('snapshot budget truncates, subtree observe reaches the rest, disabled/hidden are not executed #%i', async (i) => {
        const L = ledgerRun(stack, `a06-trunc-${i}`)
        const url = pageUrl(stack, SITE_A, '/x5/controls', { n: '30' }, L)
        const t = await newTaskWithPage(c, url)
        const tDisabled = await newTaskWithPage(c, url, { taskSpaceId: t.taskSpaceId })
        const tHidden = await newTaskWithPage(c, url, { taskSpaceId: t.taskSpaceId })
        try {
            const small = await c.observe({ taskId: t.taskId, tabId: t.tabId, maxElements: 4 })
            expect(small.truncated).toBe(true)
            expect(small.elements.length).toBeLessThanOrEqual(4)
            expect(small.elements.some((e) => e.name === 'Item 30')).toBe(false)
            const form = small.elements.find((e) => e.role === 'form')
            expect(form, 'form container must be inside the truncated budget').toBeDefined()
            const sub = await c.observe({ taskId: t.taskId, tabId: t.tabId, scopeRef: form!.ref })
            const item30 = sub.elements.find((e) => e.name === 'Item 30')
            expect(item30, 'subtree observation must reach elements cut by truncation').toBeDefined()
            const r = await batch(c, t.taskId, t.version, [[t.tabId, 'click', { ref: item30!.ref, snapshotId: sub.snapshotId }]])
            let ledger = await waitLedger(stack, L, (e) => count(e, 'click') >= 1, { settleMs: 1_000 })
            const clicked = ledger.filter((e) => e.kind === 'click').map((e) => e.target)
            evidence('A06', { path: 'truncation-subtree', i, truncated: small.truncated, smallCount: small.elements.length, subCount: sub.elements.length, subRef: item30!.ref, outcome: r.result.outcome, clicked })
            expect(clicked, 'CONTRACT: subtree ref must click exactly Item 30').toEqual(['item-30'])

            const d = await c.observe({ taskId: tDisabled.taskId, tabId: tDisabled.tabId })
            const disabled = d.elements.find((e) => e.name === 'Disabled action')!
            expect(disabled.disabled).toBe(true)
            const rd = await batch(c, tDisabled.taskId, tDisabled.version, [[tDisabled.tabId, 'click', { ref: disabled.ref as ElementRef, snapshotId: d.snapshotId }]])
            const h = await c.observe({ taskId: tHidden.taskId, tabId: tHidden.tabId })
            const hidden = h.elements.find((e) => e.name === 'Hidden action')
            const rh = hidden ? await batch(c, tHidden.taskId, tHidden.version, [[tHidden.tabId, 'click', { ref: hidden.ref, snapshotId: h.snapshotId }]]) : undefined
            ledger = await settledLedger(stack, L, 1_000)
            evidence('A06', { path: 'disabled-hidden', i, disabledOutcome: rd.result.outcome, disabledCode: failedCode(rd.result), hiddenInSnapshot: !!hidden, hiddenVisible: hidden?.visible, hiddenOutcome: rh?.result.outcome, hiddenCode: rh && failedCode(rh.result) })
            expect(rd.result.outcome).not.toBe('succeeded')
            expect(count(ledger, 'click', { target: 'disabled' })).toBe(0)
            if (hidden) {
                expect(hidden.visible).toBe(false)
                expect(rh!.result.outcome).not.toBe('succeeded')
            }
            expect(count(ledger, 'click', { target: 'hidden' })).toBe(0)
        } finally {
            expect(await cleanupSpace(stack, c, t.taskSpaceId, [t.taskId, tDisabled.taskId, tHidden.taskId])).toBeUndefined()
        }
    })

    it('records unsupported surfaces (closed shadow root / canvas) as not covered', () => {
        evidence('A06', { path: 'unsupported', closedShadow: 'unsupported in first PoC (no fixture, driver collects open shadow roots only)', canvas: 'unsupported in first PoC' })
    })
})
