import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, SCHEMA_VERSION, type TaskId, type TaskSpaceId } from './contracts'
import { TaskStore, type StoredTask } from './taskStore'

const dirs: string[] = []
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'abp-store-')); dirs.push(dir); return dir }
const sample = (): StoredTask => ({ schemaVersion: SCHEMA_VERSION, taskId: 't1' as TaskId, taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as never, agentSessionId: 'a1' as never, status: 'queued', cancelRequested: false, stateVersion: 1, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' }, actions: {}, approvals: {}, batches: {}, dedupe: {} })
const event = { type: 'task-created' as const, atMs: 1, stateVersion: 1, leaseEpoch: 0, data: {} }

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('TaskStore writer and journal guarantees', () => {
    it('refuses a second live writer and rejects commits after fencing changes', async () => {
        const dir = await tempDir(); const first = await TaskStore.open(dir)
        await expect(TaskStore.open(dir)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await first.createTask(sample(), event)
        await writeFile(join(dir, 'fencing'), '999')
        await expect(first.commit('t1' as TaskId, { status: 'running' }, { ...event, type: 'state-changed' })).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await first.close()
    })

    it('takes over a stale lock whose PID was reused by this process', async () => {
        const dir = await tempDir()
        const previous = await TaskStore.open(dir)
        await previous.close()
        await writeFile(join(dir, 'writer.lock'), JSON.stringify({ pid: process.pid, fencingToken: 1, started: 1 }))

        const restarted = await TaskStore.open(dir)
        await expect(restarted.createTask(sample(), event)).resolves.toMatchObject({ taskId: 't1' })
        await restarted.close()
    })

    it('uses the lock heartbeat lease to distinguish a live same-PID writer from a stale one', async () => {
        const dir = await tempDir()
        let now = 100
        const first = await TaskStore.open(dir, undefined, () => now)
        now = 10_000
        await first.heartbeat()
        now = 29_999
        await expect(TaskStore.open(dir, undefined, () => now)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        now = 30_001
        const replacement = await TaskStore.open(dir, undefined, () => now)
        await expect(first.createTask(sample(), event)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await replacement.close()
        await first.close()
    })

    it('does not ACK a failed journal append', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir, (operation) => { if (operation === 'event-append') throw new Error('ENOSPC') })
        await expect(store.createTask(sample(), event)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        expect(store.getTask('t1' as TaskId)).toBeUndefined()
        await store.close()
    })

    it('does not reuse an event sequence when checkpoint replacement fails', async () => {
        const dir = await tempDir()
        let failReplace = true
        const store = await TaskStore.open(dir, (operation) => {
            if (operation === 'task-replace' && failReplace) {
                failReplace = false
                throw new Error('disk full')
            }
        })
        await expect(store.createTask(sample(), event)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await expect(store.createTask(sample(), event)).resolves.toMatchObject({ taskId: 't1' })
        await store.close()
        const reopened = await TaskStore.open(dir)
        expect(reopened.getTask('t1' as TaskId)?.highWatermarkSeq).toBe(1)
        await reopened.close()
    })

    it('keeps an in-memory grant revocation when its journal write fails', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir, (operation) => {
            if (operation === 'metadata')
                throw new Error('disk full')
        })
        await expect(store.revoke('grant-1')).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        expect(store.isRevoked('grant-1')).toBe(true)
        await store.close()
    })

    it('preserves updatedAtMs for bookkeeping commits', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const task = await store.createTask(sample(), event)
        const updated = await store.commit(task.taskId, { stateVersion: task.stateVersion }, {
            ...event,
            type: 'state-changed',
            atMs: 500,
        })
        expect(updated.updatedAtMs).toBe(task.updatedAtMs)
        await store.close()
    })

    it('recovers from a transient append failure without disabling unrelated writes', async () => {
        const dir = await tempDir(); let failOnce = true
        const store = await TaskStore.open(dir, (operation) => {
            if (operation === 'event-append' && failOnce) {
                failOnce = false
                throw new Error('ENOSPC')
            }
        })
        await expect(store.createTask(sample(), event)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await expect(store.createTask({ ...sample(), taskId: 't2' as TaskId }, event)).resolves.toMatchObject({ taskId: 't2' })
        await store.close()
    })

    it('quarantines a garbled final line during recovery', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir)
        await store.createTask(sample(), event); await store.close()
        const events = join(dir, 'tasks', 't1', 'events.jsonl'); await writeFile(events, `${await readFile(events, 'utf8')}partial`)
        const recovered = await TaskStore.open(dir)
        expect(recovered.getTask('t1' as TaskId)?.highWatermarkSeq).toBe(1)
        expect(await readFile(join(dir, 'tasks', 't1', 'events.orphan.jsonl'), 'utf8')).toContain('partial')
        expect((await readFile(events, 'utf8')).trim().split('\n')).toHaveLength(1)
        await recovered.close()
    })

    it('fails closed for the corrupt task while leaving unrelated tasks writable', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir)
        await store.createTask(sample(), event)
        await store.commit('t1' as TaskId, { status: 'running' }, { ...event, type: 'state-changed', atMs: 2 })
        await store.createTask({ ...sample(), taskId: 't2' as TaskId }, event)
        await store.close()
        const file = join(dir, 'tasks', 't1', 'events.jsonl')
        const contents = await readFile(file, 'utf8')
        await writeFile(file, contents.replace('task-created', 'task-corrupt'))
        const recovered = await TaskStore.open(dir)
        expect(() => recovered.getTask('t1' as TaskId)).toThrowError(expect.objectContaining({ code: 'JOURNAL_UNAVAILABLE' }))
        await expect(recovered.commit('t2' as TaskId, { status: 'running' }, { ...event, type: 'state-changed', atMs: 3 })).resolves.toMatchObject({ status: 'running' })
        await recovered.close()
    })
})
