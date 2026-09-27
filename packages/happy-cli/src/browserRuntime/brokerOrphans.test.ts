/** Broker orphan retention, crash recovery and TTL sweeps without a listening socket. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttentionOutbox } from './attention'
import { startBroker } from './broker'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(registry: object, now: () => number, endSession: (id: string) => Promise<void>, intervalMs = 60_000) {
    const dir = await mkdtemp(join(tmpdir(), 'abp-orphans-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'broker-sessions.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, registrations: {}, ...registry }))
    const broker = await startBroker({ stateDir: dir, socketPath: join(dir, 'unused.sock'), server: createServer(),
        attention: await AttentionOutbox.open(dir), daemonTokenSha256: createHash('sha256').update('test').digest('hex'),
        identity: { machineId: 'm' as never, workspaceId: 'w' as never }, profiles: new Map(), allowedOrigins: [],
        agentKey: 'synthetic-key', revokeGrant: async () => {}, endSession, now, orphanTtlMs: 100, orphanSweepIntervalMs: intervalMs })
    cleanup.push(() => broker.close())
    return { broker, read: async () => JSON.parse(await readFile(path, 'utf8')) as { orphanedSessions?: Record<string, number> } }
}

describe('durable orphan sweep', () => {
    it('loads legacy registry files and retains live registrations even with an old orphan mark', async () => {
        const ended: string[] = []
        const legacy = await fixture({}, () => 1000, async id => { ended.push(id) })
        await legacy.broker.sweepOrphans()
        const live = await fixture({ orphanedSessions: { s: 0 }, registrations: { r: {
            secretSha256: 'hash', agentSessionId: 's', createdAtMs: 0, grantIds: [],
        } } }, () => 1000, async id => { ended.push(id) })
        await live.broker.sweepOrphans()
        expect(ended).toEqual([])
    })

    it('sweeps at startup and retries a failed end without forgetting its durable timestamp', async () => {
        let failing = true
        const ended: string[] = []
        const h = await fixture({ orphanedSessions: { expired: 0, recent: 999 } }, () => 1000,
            async id => { if (failing) throw new Error('journal unavailable'); ended.push(id) })
        await expect(h.broker.sweepOrphans()).rejects.toThrow('journal unavailable')
        expect((await h.read()).orphanedSessions).toEqual({ expired: 0, recent: 999 })
        failing = false
        await h.broker.sweepOrphans()
        expect(ended).toEqual(['expired'])
        expect((await h.read()).orphanedSessions).toEqual({ recent: 999 })
        const restarted = await fixture({ orphanedSessions: { overdue: 0 } }, () => 1000, async id => { ended.push(id) })
        await vi.waitFor(() => expect(ended).toEqual(['expired', 'overdue']))
        await vi.waitFor(async () => expect((await restarted.read()).orphanedSessions).toEqual({}))
    })

    it('periodically reclaims only after the configured TTL', async () => {
        let now = 99
        const ended: string[] = []
        await fixture({ orphanedSessions: { s: 0 } }, () => now, async id => { ended.push(id) }, 10)
        expect(ended).toEqual([])
        now = 101
        await vi.waitFor(() => expect(ended).toEqual(['s']))
    })
})
