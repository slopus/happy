import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, ProfileId, RequestId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('task space tab registry under concurrency', () => {
    it('registers every tab opened concurrently in one space, and closes each of them', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-space-tabs-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-a' as ProfileId
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites: fixtureSitePolicies(['https://fixture.test']) })
        const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never,
            agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'],
            operations: ['createSpace', 'createTask', 'openPage', 'closePage', 'getTask', 'finishTask'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential: grant, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
        const opened = await Promise.all([0, 1, 2, 3].map(async (i) => {
            const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: `task-${i}` as RequestId })
            return runtime.openPage(auth, { taskId: task.taskId, url: `https://fixture.test/p${i}`, requestId: `open-${i}` as RequestId })
        }))
        expect(new Set(store.getSpace(space.taskSpaceId)!.tabs)).toEqual(new Set(opened.map((page) => page.tabId)))
        for (const [i, page] of opened.entries()) {
            const current = await runtime.getTask(auth, { taskId: page.task.taskId })
            await runtime.finishTask(auth, { taskId: page.task.taskId, expectedVersion: current.stateVersion, requestId: `finish-${i}` as RequestId })
        }
        await Promise.all(opened.map((page, i) => runtime.closePage(auth, { taskSpaceId: space.taskSpaceId, tabId: page.tabId, requestId: `close-${i}` as RequestId })))
        expect(store.getSpace(space.taskSpaceId)!.tabs).toEqual([])
        await store.close()
    })
})
