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
                await Promise.all([machines.list(), sessions.list()]);
            },
            onUpdate: update => { void this.handleUpdate(update); },
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
        this.messages = new MessagesResourceImpl(http, sessions, this.encryption);
        this.requests = new RequestsResourceImpl(this.realtime, sessions);
    }

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
                    || typeof raw.seq !== 'number'
                    || typeof raw.content?.c !== 'string'
                    || typeof raw.createdAt !== 'number'
                    || typeof raw.updatedAt !== 'number'
                ) {
                    throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Realtime message payload is malformed');
                }
                this.events.emit({
                    type: 'message',
                    sessionId,
                    message: {
                        id: raw.id,
                        seq: raw.seq,
                        content: decrypt(encryption.key, encryption.variant, decodeBase64(raw.content.c)),
                        localId: typeof raw.localId === 'string' ? raw.localId : null,
                        createdAt: raw.createdAt,
                        updatedAt: raw.updatedAt,
                    },
                });
                return;
            }

            if (record.t === 'update-session' || record.t === 'new-session') {
                const sessions = await this.sessionsImpl.list();
                const sessionId = record.id ?? record.sid ?? record.session?.id;
                const session = sessions.find(candidate => candidate.id === sessionId);
                if (!session) return;
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
                await this.machines.list();
            }
        } catch (cause) {
            const error = cause instanceof PawsAgentError
                ? cause
                : new PawsAgentError('UNKNOWN', 'Realtime update failed', { cause });
            this.events.emit({ type: 'error', error });
        }
    }
}
