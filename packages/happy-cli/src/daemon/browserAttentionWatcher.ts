/**
 * D10 daemon attention delivery. The server owns localId deduplication; the
 * cursor advances only after acknowledged delivery (or a recorded skip).
 * One poll is processed at a time, with no unbounded queue or sent-id cache.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ATTENTION_REASONS, type AttentionEvent, type AttentionFeed } from '@/browserRuntime/contracts'

const MAX_EVENTS = 1_000
const MAX_SKIPS = 100
const seq = z.number().int().nonnegative().safe()
const eventSchema = z.object({
    seq, taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    agentSessionId: z.string().min(1).max(256), status: z.enum(['queued', 'running', 'paused', 'awaiting-user', 'recovering', 'succeeded', 'failed', 'cancelled']),
    eventSeq: seq, reason: z.enum(ATTENTION_REASONS),
})
const feedSchema = z.union([
    z.object({ events: z.array(eventSchema).max(MAX_EVENTS), nextSeq: seq, oldestSeq: seq }).strict(),
    z.object({ code: z.literal('CURSOR_EXPIRED'), events: z.tuple([]), snapshot: z.array(eventSchema).max(MAX_EVENTS), nextSeq: seq, oldestSeq: seq }).strict(),
])
const skipSchema = eventSchema.pick({ taskId: true, agentSessionId: true, eventSeq: true }).extend({ reason: z.enum(['ended', 'unowned']) })
const cursorSchema = z.object({ schemaVersion: z.literal(1), afterSeq: seq, skipped: z.array(skipSchema).max(MAX_SKIPS) }).strict()
export type AttentionCursor = z.infer<typeof cursorSchema>
export interface AttentionCursorStore {
    read(): Promise<AttentionCursor>
    save(state: AttentionCursor): Promise<void>
}

export function createAttentionCursorStore(file: string): AttentionCursorStore {
    return {
        async read() {
            let handle
            try {
                handle = await open(file, 'r')
                if ((await handle.stat()).size > 128 * 1024) throw new Error('Attention cursor too large')
                return cursorSchema.parse(JSON.parse(await handle.readFile('utf8')))
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                return { schemaVersion: 1, afterSeq: 0, skipped: [] }
            } finally { await handle?.close() }
        },
        async save(state) {
            const data = JSON.stringify(cursorSchema.parse(state))
            const directory = dirname(file)
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const temporary = `${file}.${randomUUID()}.tmp`
            try {
                const handle = await open(temporary, 'wx', 0o600)
                try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
                await rename(temporary, file)
                const dir = await open(directory, 'r')
                try { await dir.sync() } finally { await dir.close() }
            } finally { await rm(temporary, { force: true }) }
        },
    }
}

interface WatcherOptions {
    store: AttentionCursorStore
    poll(afterSeq: number, signal: AbortSignal): Promise<AttentionFeed>
    deliver(event: AttentionEvent, signal: AbortSignal): Promise<'sent' | 'ended' | 'unowned'>
    sleep?(ms: number, signal: AbortSignal): Promise<void>
    log?(message: string): void
}

export class BrowserAttentionWatcher {
    private readonly abort = new AbortController()
    constructor(private readonly options: WatcherOptions) { }
    stop(): void { this.abort.abort() }

    async pollOnce(): Promise<void> {
        const { signal } = this.abort
        signal.throwIfAborted()
        let state = await this.options.store.read()
        const feed = feedSchema.parse(await this.options.poll(state.afterSeq, signal)) as AttentionFeed
        const expired = 'code' in feed
        const events = expired ? feed.snapshot : feed.events
        // Validate the complete batch before sending anything or moving a cursor.
        if ((!expired && feed.nextSeq < state.afterSeq)
            || events.some((event, index) => event.seq > feed.nextSeq || (!expired && index > 0 && event.seq < events[index - 1].seq))) {
            throw new Error('Invalid attention sequence')
        }
        for (const event of events) {
            signal.throwIfAborted()
            if (!expired && event.seq <= state.afterSeq) continue
            const result = await this.options.deliver(event, signal)
            if (result !== 'sent') {
                state = { ...state, skipped: [...state.skipped, { taskId: event.taskId, agentSessionId: event.agentSessionId, eventSeq: event.eventSeq, reason: result }].slice(-MAX_SKIPS) }
            }
            // A snapshot is a single checkpoint: partial delivery must replay it.
            if (!expired) {
                state = { ...state, afterSeq: event.seq }
                await this.options.store.save(state)
            }
        }
        if (expired || state.afterSeq !== feed.nextSeq) {
            await this.options.store.save({ ...state, afterSeq: feed.nextSeq })
        }
    }

    async run(): Promise<void> {
        let backoff = 1_000
        const sleep = this.options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
        while (!this.abort.signal.aborted) {
            let waitMs = 1_000 // Also bounds fast empty/misconfigured feed replies.
            try {
                await this.pollOnce()
                backoff = 1_000
            } catch {
                if (this.abort.signal.aborted) break
                // Never log transport errors: axios errors can contain auth headers.
                this.options.log?.(`[agent-browser] attention delivery retry in ${backoff}ms`)
                waitMs = backoff
                backoff = Math.min(backoff * 2, 300_000)
            }
            try { await sleep(waitMs, this.abort.signal) } catch {
                if (!this.abort.signal.aborted) throw new Error('Attention retry timer failed')
            }
        }
    }
}
