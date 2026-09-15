import { PawsAgentError } from './errors';
import { PawsAgentEvents } from './events';
import type {
    AgentRequest,
    MachinesResource,
    MessagesResource,
    PawsAgentClientOptions,
    PawsAgentEventListener,
    RequestsResource,
    SessionsResource,
} from './types';
import { decodeBase64, decrypt } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
import { MachinesResourceImpl } from '../resources/machines';
import { MessagesResourceImpl } from '../resources/messages';
import { validSequence } from '../resources/messageWatch';
import { RequestsResourceImpl } from '../resources/requests';
import { SessionsResourceImpl } from '../resources/sessions';
import { PawsHttpTransport } from '../transport/http';
import { PawsRealtimeTransport } from '../transport/realtime';

export class PawsAgentClient {
    readonly machines: MachinesResource;
    readonly sessions: SessionsResource;
    readonly messages: MessagesResource;
    readonly requests: RequestsResource;

    private readonly events: PawsAgentEvents;
    private readonly encryption = new RecordEncryptionStore();
    private readonly http: PawsHttpTransport;
    private readonly realtime: PawsRealtimeTransport;
    private readonly sessionsImpl: SessionsResourceImpl;
    private readonly messagesImpl: MessagesResourceImpl;
    private updates: Promise<void> = Promise.resolve();
    private streamQueue: Array<{ sid: string; content: { t: 'encrypted'; c: string } }> = [];
    private streamQueueBytes = 0;
    private drainingStreams = false;
    private disposed = false;

    constructor(options: PawsAgentClientOptions) {
        this.events = new PawsAgentEvents(options.logger);
        const http = new PawsHttpTransport(options);
        this.http = http;
        let machines!: MachinesResourceImpl;
        let sessions!: SessionsResourceImpl;
        this.realtime = new PawsRealtimeTransport({
            serverUrl: options.serverUrl,
            credentials: options.credentials,
            encryption: this.encryption,
            events: this.events,
            logger: options.logger,
            reconnect: options.reconnect,
            resync: async () => {
                const [machineSnapshot, sessionSnapshot] = await Promise.all([machines.list(), sessions.list()]);
                await this.messagesImpl.syncWatches();
                if (!this.disposed) {
                    this.events.emit({ type: 'snapshot', machines: machineSnapshot, sessions: sessionSnapshot });
                }
            },
            onUpdate: update => {
                const body = (update as { body?: { t?: unknown; sid?: unknown; message?: { seq?: unknown } } } | null)?.body;
                if (body?.t === 'new-message' && typeof body.sid === 'string') this.messagesImpl.notify(body.sid, body.message?.seq);
                this.updates = this.updates.then(() => this.handleUpdate(update));
            },
            onSessionStream: update => this.enqueueSessionStream(update),
        });
        machines = new MachinesResourceImpl(http, this.realtime, this.encryption);
        sessions = new SessionsResourceImpl(
            http,
            this.realtime,
            this.encryption,
            () => machines.list(),
        );
        this.sessionsImpl = sessions;
        this.machines = machines;
        this.sessions = sessions;
        this.messagesImpl = new MessagesResourceImpl(http, sessions, this.encryption, error => {
            if (!this.disposed) this.events.emit({ type: 'error', error });
        });
        this.messages = this.messagesImpl;
        this.requests = new RequestsResourceImpl(this.realtime, sessions);
    }

    /** Best-effort live events. Use messages.watch for ordered durable delivery and reconnect replay. */
    subscribe(listener: PawsAgentEventListener): () => void {
        if (this.disposed) {
            throw new PawsAgentError('CONNECTION_LOST', 'Client has been disposed');
        }
        return this.events.subscribe(listener);
    }

    connect(): Promise<void> {
        return this.realtime.connect();
    }

    disconnect(): Promise<void> {
        return this.realtime.disconnect();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.streamQueue = [];
        this.streamQueueBytes = 0;
        this.messagesImpl.dispose();
        this.http.dispose();
        await this.realtime.dispose();
        this.encryption.clear();
        this.events.clear();
    }

    private async handleUpdate(update: unknown): Promise<void> {
        if (this.disposed || update == null || typeof update !== 'object') return;
        try {
            const body = (update as { body?: unknown }).body;
            if (!body || typeof body !== 'object') return;
            const record = body as {
                t?: unknown;
                id?: unknown;
                sid?: unknown;
                session?: { id?: unknown };
                message?: {
                    id?: unknown;
                    seq?: unknown;
                    content?: { t?: unknown; c?: unknown };
                    localId?: unknown;
                    createdAt?: unknown;
                    updatedAt?: unknown;
                };
            };

            if (record.t === 'new-message' && record.message?.content?.t === 'encrypted') {
                const sessionId = record.sid;
                if (typeof sessionId !== 'string') return;
                let encryption = this.encryption.getSession(sessionId);
                if (!encryption) {
                    await this.sessionsImpl.get(sessionId);
                    encryption = this.encryption.getSession(sessionId);
                }
                if (!encryption) throw new PawsAgentError('DECRYPTION_FAILED', 'Session encryption is unavailable');
                const raw = record.message;
                if (
                    typeof raw.id !== 'string'
                    || !validSequence(raw.seq)
                    || typeof raw.content?.c !== 'string'
                    || typeof raw.createdAt !== 'number'
                    || typeof raw.updatedAt !== 'number'
                ) {
                    throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Realtime message payload is malformed');
                }
                if (this.disposed) return;
                const content = decrypt(encryption.key, encryption.variant, decodeBase64(raw.content.c));
                if (content === null) throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt realtime message');
                this.events.emit({
                    type: 'message',
                    sessionId,
                    message: {
                        id: raw.id,
                        seq: raw.seq,
                        content,
                        localId: typeof raw.localId === 'string' ? raw.localId : null,
                        createdAt: raw.createdAt,
                        updatedAt: raw.updatedAt,
                    },
                });
                return;
            }

            if (record.t === 'update-session' || record.t === 'new-session') {
                const sessionId = record.id ?? record.sid ?? record.session?.id;
                if (typeof sessionId !== 'string' || !sessionId.trim()) return;
                const session = await this.sessionsImpl.get(sessionId).catch(cause => {
                    // A session can be deleted between the event and its snapshot read.
                    if (cause instanceof PawsAgentError && cause.code === 'NOT_FOUND') return null;
                    throw cause;
                });
                if (!session || this.disposed) return;
                this.events.emit({ type: 'session', session });
                const state = session.agentState as { requests?: Record<string, unknown> } | null;
                for (const [id, payload] of Object.entries(state?.requests ?? {})) {
                    const value = payload as { type?: unknown; tool?: unknown } | null;
                    const request: AgentRequest = {
                        id,
                        type: typeof value?.type === 'string'
                            ? value.type
                            : typeof value?.tool === 'string' ? value.tool : 'permission',
                        payload,
                    };
                    this.events.emit({ type: 'request', sessionId: session.id, request });
                }
            } else if (record.t === 'update-machine' || record.t === 'new-machine') {
                const machines = await this.machines.list();
                if (this.disposed) return;
                this.events.emit({ type: 'machines', machines });
            }
        } catch (cause) {
            if (this.disposed) return;
            const error = cause instanceof PawsAgentError
                ? cause
                : new PawsAgentError('UNKNOWN', 'Realtime update failed', { cause });
            this.events.emit({ type: 'error', error });
        }
    }

    private enqueueSessionStream(update: unknown): void {
        if (this.disposed) return;
        const envelope = update as { sid?: unknown; content?: { t?: unknown; c?: unknown } } | null;
        if (!envelope || typeof envelope.sid !== 'string' || !envelope.sid || envelope.sid.length > 512
            || envelope.content?.t !== 'encrypted' || typeof envelope.content.c !== 'string'
            || !envelope.content.c || envelope.content.c.length > 900 * 1024) {
            this.events.emit({ type: 'error', error: new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Malformed session stream envelope') });
            return;
        }
        // Keep previews independent of metadata HTTP work. Bound both event count
        // and retained ciphertext while a stream's session key is being fetched.
        while (this.streamQueue.length >= 8 || this.streamQueueBytes + envelope.content.c.length > 900 * 1024) {
            const dropped = this.streamQueue.shift();
            if (!dropped) break;
            this.streamQueueBytes -= dropped.content.c.length;
        }
        this.streamQueue.push({ sid: envelope.sid, content: { t: 'encrypted', c: envelope.content.c } });
        this.streamQueueBytes += envelope.content.c.length;
        if (!this.drainingStreams) void this.drainSessionStreams();
    }

    private async drainSessionStreams(): Promise<void> {
        this.drainingStreams = true;
        try {
            while (!this.disposed && this.streamQueue.length) {
                const envelope = this.streamQueue.shift()!;
                this.streamQueueBytes -= envelope.content.c.length;
                await this.handleSessionStream(envelope);
            }
        } finally { this.drainingStreams = false; }
    }

    private async handleSessionStream(update: unknown): Promise<void> {
        if (this.disposed) return;
        try {
            const envelope = update as { sid?: unknown; content?: { t?: unknown; c?: unknown } } | null;
            if (!envelope || typeof envelope.sid !== 'string' || !envelope.sid || envelope.sid.length > 512
                || envelope.content?.t !== 'encrypted' || typeof envelope.content.c !== 'string'
                || !envelope.content.c || envelope.content.c.length > 900 * 1024) {
                throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Malformed session stream envelope');
            }
            let encryption = this.encryption.getSession(envelope.sid);
            if (!encryption) {
                await this.sessionsImpl.get(envelope.sid);
                encryption = this.encryption.getSession(envelope.sid);
            }
            if (this.disposed) return;
            if (!encryption) throw new PawsAgentError('DECRYPTION_FAILED', 'Session encryption is unavailable');
            let value: unknown;
            try { value = decrypt(encryption.key, encryption.variant, decodeBase64(envelope.content.c)); }
            catch { throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt session stream'); }
            if (value === null) throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt session stream');
            const stream = value as { type?: unknown; turnId?: unknown; itemId?: unknown; delta?: unknown; text?: unknown };
            if (!stream || stream.type !== 'text-delta'
                || typeof stream.turnId !== 'string' || !stream.turnId || stream.turnId.length > 512
                || typeof stream.itemId !== 'string' || !stream.itemId || stream.itemId.length > 512
                || typeof stream.delta !== 'string' || stream.delta.length > 1024 * 1024
                || typeof stream.text !== 'string' || stream.text.length > 1024 * 1024
                || new TextEncoder().encode(stream.delta).byteLength > 1024 * 1024
                || new TextEncoder().encode(stream.text).byteLength > 1024 * 1024
                || !stream.text.endsWith(stream.delta)) {
                throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Malformed session text delta');
            }
            this.events.emit({ type: 'text-delta', sessionId: envelope.sid, turnId: stream.turnId, itemId: stream.itemId, delta: stream.delta, text: stream.text });
        } catch (cause) {
            if (!this.disposed) this.events.emit({ type: 'error', error: cause instanceof PawsAgentError ? cause : new PawsAgentError('UNKNOWN', 'Session stream failed') });
        }
    }
}
