import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionEvent, AttentionFeed } from '@/browserRuntime/contracts'
import { BrowserAttentionWatcher, createAttentionCursorStore } from './browserAttentionWatcher'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-watch-')); dirs.push(dir)
    const file = join(dir, 'cursor.json')
    return { file, store: createAttentionCursorStore(file) }
}
const event = (seq: number): AttentionEvent => ({ seq, taskId: 'task-1' as AttentionEvent['taskId'], agentSessionId: 'session-1' as AttentionEvent['agentSessionId'], status: 'paused', eventSeq: seq + 10, reason: 'approval-approved' })
const feed = (...events: AttentionEvent[]): AttentionFeed => ({ events, nextSeq: events.at(-1)?.seq ?? 0, oldestSeq: 1 })

describe('daemon attention watcher durability', () => {
    it('persists acknowledged progress and ignores repeated feed entries across restart', async () => {
        const { store } = await fixture(); const sent: number[] = []; const cursors: number[] = []
        const options = { store, poll: async (after: number) => { cursors.push(after); return feed(event(1), event(1), event(2)) }, deliver: async (e: AttentionEvent) => { sent.push(e.seq); return 'sent' as const } }
        await new BrowserAttentionWatcher(options).pollOnce()
        await new BrowserAttentionWatcher(options).pollOnce()
        expect(sent).toEqual([1, 2]); expect(cursors).toEqual([0, 2])
        expect((await store.read()).afterSeq).toBe(2)
    })

    it.each(['before-ack', 'after-ack'] as const)('replays with the same localId after a crash %s', async (failure) => {
        const { store } = await fixture(); const accepted = new Set<string>(); const attempts: string[] = []
        let crash = true
        const deliver = async (e: AttentionEvent) => {
            const localId = `abp-${e.taskId}-${e.eventSeq}`; attempts.push(localId)
            if (failure === 'before-ack' && crash) throw new Error('injected disconnect')
            accepted.add(localId)
            return 'sent' as const
        }
        const brokenStore = { read: store.read, save: async (state: Awaited<ReturnType<typeof store.read>>) => {
            if (failure === 'after-ack' && crash) throw new Error('injected fsync failure')
            await store.save(state)
        } }
        await expect(new BrowserAttentionWatcher({ store: brokenStore, poll: async () => feed(event(1)), deliver }).pollOnce()).rejects.toThrow('injected')
        expect((await store.read()).afterSeq).toBe(0)
        crash = false
        await new BrowserAttentionWatcher({ store, poll: async () => feed(event(1)), deliver }).pollOnce()
        expect(attempts).toEqual(['abp-task-1-11', 'abp-task-1-11']); expect(accepted.size).toBe(1)
    })

    it('uses an expired cursor snapshot and saves its nextSeq only after every acknowledgement', async () => {
        const { store } = await fixture(); await store.save({ schemaVersion: 1, afterSeq: 90, skipped: [] })
        const snapshot: AttentionFeed = { code: 'CURSOR_EXPIRED', events: [], snapshot: [event(2), event(4)], nextSeq: 5, oldestSeq: 2 }
        const sent: number[] = []; let fail = true
        const options = { store, poll: async () => snapshot, deliver: async (e: AttentionEvent) => { sent.push(e.seq); if (e.seq === 4 && fail) throw new Error('ack lost'); return 'sent' as const } }
        await expect(new BrowserAttentionWatcher(options).pollOnce()).rejects.toThrow('ack lost')
        expect((await store.read()).afterSeq).toBe(90)
        fail = false; await new BrowserAttentionWatcher(options).pollOnce()
        expect(sent).toEqual([2, 4, 2, 4]); expect((await store.read()).afterSeq).toBe(5)
    })

    it('accepts snapshots in task insertion order rather than feed sequence order', async () => {
        const { store } = await fixture(); const sent: number[] = []
        await new BrowserAttentionWatcher({ store,
            poll: async () => ({ code: 'CURSOR_EXPIRED', events: [], snapshot: [event(4), event(2)], nextSeq: 4, oldestSeq: 2 }),
            deliver: async e => { sent.push(e.seq); return 'sent' },
        }).pollOnce()
        expect(sent).toEqual([4, 2]); expect((await store.read()).afterSeq).toBe(4)
    })

    it('records ended and unowned skips with bounded retention', async () => {
        const { store, file } = await fixture()
        await new BrowserAttentionWatcher({ store, poll: async () => feed(...Array.from({ length: 150 }, (_, i) => event(i + 1))), deliver: async e => e.seq % 2 ? 'ended' : 'unowned' }).pollOnce()
        const state = await store.read(); expect(state.afterSeq).toBe(150); expect(state.skipped).toHaveLength(100)
        expect(state.skipped.at(-1)).toMatchObject({ taskId: 'task-1', eventSeq: 160, reason: 'unowned' })
        expect((await readFile(file, 'utf8')).length).toBeLessThan(20_000)
    }, 30_000) // 150 fsync'd cursor writes: slow on a loaded disk, not a correctness limit

    it('fails closed on corrupt cursors and invalid or oversized feeds', async () => {
        const { store, file } = await fixture(); let delivered = false
        await writeFile(file, '{broken')
        const watcher = new BrowserAttentionWatcher({ store, poll: async () => feed(event(1)), deliver: async () => { delivered = true; return 'sent' } })
        await expect(watcher.pollOnce()).rejects.toThrow(); expect(delivered).toBe(false)
        await rm(file)
        for (const invalid of [feed({ ...event(1), taskId: 'bad\ninstruction' as AttentionEvent['taskId'] }), feed(...Array.from({ length: 1001 }, (_, i) => event(i + 1))), feed(event(2), event(1))]) {
            await expect(new BrowserAttentionWatcher({ store, poll: async () => invalid, deliver: async () => { delivered = true; return 'sent' } }).pollOnce()).rejects.toThrow()
        }
        expect(delivered).toBe(false)
    })

    it('backs off exponentially to five minutes, resets after success, and stops', async () => {
        const { store } = await fixture(); const delays: number[] = []; let calls = 0
        const watcher = new BrowserAttentionWatcher({ store, poll: async () => { calls++; if (calls !== 12) throw new Error('offline'); return feed() }, deliver: async () => 'sent', sleep: async ms => { delays.push(ms); if (delays.length === 13) watcher.stop() } })
        await watcher.run()
        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 1000, 1000])
    })
})
