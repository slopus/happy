import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, InteractiveCapability, ProfileId, RequestId } from './contracts'
import { mintAgentGrant } from './auth'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** D12: the console finds the principal's open tasks on a profile without a pasted task id. */
async function createHarness() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-list-tasks-')); dirs.push(dir)
    const store = await TaskStore.open(dir); const clock = new FakeClock(100)
    const profileA = 'profile-a' as ProfileId; const profileB = 'profile-b' as ProfileId
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileA, new FakeBrowserDriver()], [profileB, new FakeBrowserDriver()]]), clock, sites: fixtureSitePolicies(['https://fixture.test']) })
    const grant = (principalId: string, profileId: ProfileId): AgentGrant => ({ kind: 'agent-grant', grantId: `g-${principalId}-${profileId}` as never,
        principalId: principalId as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: `a-${principalId}` as never, profileId,
        allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'cancel', 'getTask'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 })
    const agent = (principalId: string, profileId: ProfileId) => ({ credential: grant(principalId, profileId), verifiedAtMs: clock.now() })
    const capability = (profileId: ProfileId, operations: InteractiveCapability['operations'] = ['listTasks', 'getTask']): InteractiveCapability => ({
        kind: 'interactive', capabilityId: `ui-${profileId}` as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never,
        viewerSessionId: 'viewer', profileId, operations, issuedAtMs: 0, expiresAtMs: 3_600_000 })
    const ui = (profileId: ProfileId, operations?: InteractiveCapability['operations']) => ({ credential: capability(profileId, operations), verifiedAtMs: clock.now() })
    const spaces = new Map<string, string>()
    const newTask = async (principalId: string, profileId: ProfileId, tag: string) => {
        const auth = agent(principalId, profileId)
        const key = `${principalId}/${profileId}`
        if (!spaces.has(key)) spaces.set(key, (await runtime.createSpace(auth, { profileId, requestId: `space-${key}` as RequestId })).taskSpaceId)
        return { auth, task: await runtime.createTask(auth, { taskSpaceId: spaces.get(key) as never, requestId: `task-${tag}` as RequestId }) }
    }
    return { store, clock, runtime, profileA, profileB, ui, agent, newTask }
}

describe('listTasks (interactive)', () => {
    it("lists only the principal's unfinished tasks on the capability's profile, newest first", async () => {
        const h = await createHarness()
        const older = await h.newTask('p', h.profileA, 'older')
        h.clock.set(200)
        const newer = await h.newTask('p', h.profileA, 'newer')
        const finished = await h.newTask('p', h.profileA, 'finished')
        await h.runtime.cancel(finished.auth, { taskId: finished.task.taskId, requestId: 'cancel' as RequestId })
        expect((await h.runtime.getTask(finished.auth, { taskId: finished.task.taskId })).status).toBe('cancelled')
        await h.newTask('p', h.profileB, 'other-profile')
        await h.newTask('someone-else', h.profileA, 'other-principal')
        const listed = await h.runtime.listTasks(h.ui(h.profileA), { profileId: h.profileA })
        expect(listed.tasks.map((task) => task.taskId)).toEqual([newer.task.taskId, older.task.taskId])
        expect(listed.tasks[0]).toMatchObject({ profileId: h.profileA, status: newer.task.status })
        await h.store.close()
    })

    it('refuses another profile than the capability and a capability without listTasks', async () => {
        const h = await createHarness()
        await expect(h.runtime.listTasks(h.ui(h.profileA), { profileId: h.profileB })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await expect(h.runtime.listTasks(h.ui(h.profileA, ['getTask']), { profileId: h.profileA })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await h.store.close()
    })

    it('is never available to an agent grant', async () => {
        const h = await createHarness()
        const grant = { ...h.agent('p', h.profileA).credential, operations: ['listTasks'] } as AgentGrant
        expect(() => mintAgentGrant(grant, { agentKey: 'k' }, 0)).toThrow(/interactive operation/)
        await expect(h.runtime.listTasks({ credential: grant, verifiedAtMs: 0 }, { profileId: h.profileA })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await h.store.close()
    })
})
