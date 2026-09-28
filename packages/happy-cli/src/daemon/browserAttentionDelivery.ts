/** D10 transports: daemon-authenticated broker polling and encrypted user messages. */
import axios from 'axios'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { join } from 'node:path'
import { readMessageAck } from '@/api/apiSession'
import { encodeBase64, encrypt } from '@/api/encryption'
import type { AttentionEvent, AttentionFeed } from '@/browserRuntime/contracts'
import { BrowserAttentionWatcher, createAttentionCursorStore } from './browserAttentionWatcher'
import { readBrowserTaskBrokerConfig, type BrowserTaskBrokerConfig } from './browserTaskBroker'
import type { TrackedSession } from './types'

const MAX_REPLY_BYTES = 1024 * 1024

export function pollBrowserAttention(config: BrowserTaskBrokerConfig, afterSeq: number, signal: AbortSignal): Promise<AttentionFeed> {
    return new Promise((resolve, reject) => {
        const req = request({
            socketPath: config.socketPath, method: 'GET', path: `/v1/attention?afterSeq=${afterSeq}&waitMs=30000`, signal,
            headers: { 'x-abp-daemon-token': config.daemonToken },
        }, res => {
            const chunks: Buffer[] = []; let bytes = 0
            res.on('data', (chunk: Buffer) => {
                bytes += chunk.length
                if (bytes > MAX_REPLY_BYTES) req.destroy(new Error('Attention reply too large'))
                else chunks.push(chunk)
            })
            res.on('error', reject)
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; result?: AttentionFeed }
                    if (res.statusCode !== 200 || body.ok !== true || !body.result) throw new Error('Attention broker refused request')
                    resolve(body.result)
                } catch { reject(new Error('Invalid attention broker reply')) }
            })
        })
        // Absolute deadline, including a broker that trickles a response forever.
        const timer = setTimeout(() => req.destroy(new Error('Attention broker timeout')), 35_000)
        req.on('close', () => clearTimeout(timer))
        req.on('error', reject)
        req.end()
    })
}

/** Resolve attention ownership separately from the general resume lookup. */
export function findBrowserAttentionSession(
    sessionId: string,
    tracked: Iterable<TrackedSession>,
    finished: ReadonlyMap<string, TrackedSession>,
    isAlive: (pid: number) => boolean,
): TrackedSession | undefined {
    let ended: TrackedSession | undefined
    for (const session of tracked) {
        const pendingResume = !session.happySessionId && session.resumeTargetSessionId === sessionId
        if (session.happySessionId !== sessionId && !pendingResume) continue
        // A replacement awaiting its webhook still owns this attention. Never
        // checkpoint the old process's exit while that replacement is alive.
        if (isAlive(session.pid)) return session
        ended ??= session
    }
    return ended ?? finished.get(sessionId)
}

export interface HeldBrowserAttention { sessionId: string; directory: string; text: string; localId: string }

/**
 * Attentions for live run-once chats whose host parks them (Studio Chat(beta)). Such a turn exits after its
 * reply without reading a message posted meanwhile, so the attention waits for the exit and resumes the
 * session then. In memory only: a daemon restart forgets them (the session is then no longer daemon-owned).
 */
export function createHeldBrowserAttentions(now: () => number = Date.now) {
    const held = new Map<string, { attention: HeldBrowserAttention; answered: boolean }>()
    /**
     * The host asks "waiting?" once, at the turn end, which may come just after the exit took the attention
     * to resume the session: that first question is still owed a true answer. Forgotten after 10 minutes.
     */
    const owed = new Map<string, number>()
    return {
        hold(attention: HeldBrowserAttention): void { held.set(attention.sessionId, { attention, answered: false }) },
        has(sessionId: string): boolean { return held.has(sessionId) },
        take(sessionId: string): HeldBrowserAttention | undefined {
            const entry = held.get(sessionId)
            held.delete(sessionId)
            if (entry && !entry.answered) owed.set(sessionId, now())
            return entry?.attention
        },
        /** For browser-session-waiting: true while held, and once for an attention taken before anyone asked. */
        answerWaiting(sessionId: string): boolean {
            const entry = held.get(sessionId)
            if (entry) {
                entry.answered = true
                return true
            }
            const since = owed.get(sessionId)
            owed.delete(sessionId)
            return since !== undefined && now() - since < 10 * 60_000
        },
    }
}
export type HeldBrowserAttentions = ReturnType<typeof createHeldBrowserAttentions>

interface DeliveryOptions {
    serverUrl: string
    findSession(sessionId: string): TrackedSession | undefined
    isAlive(pid: number): boolean
    readToken(session: TrackedSession): Promise<string | null>
    /** Existing daemon resume path, including broker registration and run-once prompt delivery. */
    resumeSession?(input: { sessionId: string; directory: string; text: string; localId: string }): Promise<boolean>
    /** Live sessions that must get the attention at their exit instead (see createHeldBrowserAttentions). */
    holdUntilExit?: { applies(session: TrackedSession): boolean; held: HeldBrowserAttentions }
}

export async function deliverBrowserAttention(event: AttentionEvent, signal: AbortSignal, options: DeliveryOptions): Promise<'sent' | 'ended' | 'unowned'> {
    const session = options.findSession(event.agentSessionId)
    if (!session) return 'unowned'
    const localId = `abp-${event.taskId}-${event.eventSeq}`
    const text = `[agent-browser] task ${event.taskId} status=${event.status} eventSeq=${event.eventSeq}. Call getTask for the current state before continuing.`
    const directory = session.happySessionMetadataFromLocalWebhook?.path ?? session.directory
    const wake = async (): Promise<'sent' | 'ended'> => {
        signal.throwIfAborted()
        if (session.startedBy !== 'daemon' || !directory || !options.resumeSession) return 'ended'
        return await options.resumeSession({ sessionId: event.agentSessionId, directory, text, localId }) ? 'sent' : 'ended'
    }
    if (!options.isAlive(session.pid)) return wake()
    if (session.startedBy !== 'daemon') return 'unowned'
    const hold = options.holdUntilExit
    if (hold?.applies(session) && directory && options.resumeSession) {
        hold.held.hold({ sessionId: event.agentSessionId, directory, text, localId })
        // Exited in the meantime: the exit handler may already have looked. Whoever takes it resumes.
        if (!options.isAlive(session.pid) && hold.held.take(event.agentSessionId)) return wake()
        return 'sent'
    }
    if (session.happySessionId !== event.agentSessionId) throw new Error('Attention session identity unavailable')
    if (!session.encryption) throw new Error('Attention session encryption unavailable')
    const token = await options.readToken(session)
    if (!token) throw new Error('Attention session credential unavailable')
    signal.throwIfAborted()
    if (!options.isAlive(session.pid)) return wake()
    const content = encodeBase64(encrypt(session.encryption.encryptionKey, session.encryption.encryptionVariant, {
        role: 'user', content: { type: 'text', text }, localKey: localId,
        meta: { sentFrom: 'daemon', source: 'agent-browser' },
    }))
    const response = await axios.post(
        `${options.serverUrl}/v3/sessions/${encodeURIComponent(event.agentSessionId)}/messages`,
        { messages: [{ localId, content }] },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Happy-Client': 'cli-daemon/agent-browser' },
            timeout: 30_000, signal, maxContentLength: MAX_REPLY_BYTES, maxRedirects: 0 },
    )
    if (!readMessageAck(response.data?.messages, localId).ok) throw new Error('Attention message acknowledgement missing or contradictory')
    return 'sent'
}

/** Start only on an S2-configured machine, after daemon session recovery is ready. */
export function startBrowserAttentionWatcher(options: DeliveryOptions & {
    happyHomeDir: string
    machineId: string
    env?: NodeJS.ProcessEnv
    log(message: string): void
}): () => Promise<void> {
    const config = readBrowserTaskBrokerConfig(options.env)
    if (!config) return async () => {}
    const scope = createHash('sha256').update(JSON.stringify([options.serverUrl, options.machineId, config.socketPath])).digest('hex')
    const watcher = new BrowserAttentionWatcher({
        store: createAttentionCursorStore(join(options.happyHomeDir, 'browser-attention', `${scope}.json`)),
        poll: (afterSeq, signal) => pollBrowserAttention(config, afterSeq, signal),
        deliver: (event, signal) => deliverBrowserAttention(event, signal, options),
        log: options.log,
    })
    const running = watcher.run()
    return async () => { watcher.stop(); await running }
}
