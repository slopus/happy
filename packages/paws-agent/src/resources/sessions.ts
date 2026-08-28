import { PawsAgentError } from '../client/errors';
import type {
    Machine,
    ResumeSessionInput,
    Session,
    SessionsResource,
    SpawnSessionInput,
    SpawnSessionResult,
} from '../client/types';
import { decryptRecordField, RecordEncryptionStore, resolveRecordEncryption } from '../crypto/records';
import type { PawsHttpTransport } from '../transport/http';
import type { PawsRealtimeTransport } from '../transport/realtime';

type RawSession = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
};

export class SessionsResourceImpl implements SessionsResource {
    private readonly cache = new Map<string, Session>();

    constructor(
        private readonly transport: PawsHttpTransport,
        private readonly realtime: PawsRealtimeTransport,
        private readonly encryption: RecordEncryptionStore,
        private readonly listMachines: () => Promise<Machine[]>,
    ) {}

    async list(options: { active?: boolean } = {}): Promise<Session[]> {
        const path = options.active ? '/v2/sessions/active' : '/v1/sessions';
        const snapshot = await this.transport.getWithCredentials<{ sessions: RawSession[] }>(path);
        const response = snapshot.data;
        const credentials = snapshot.credentials;
        const sessions = response.sessions.map(record => {
            const encryption = resolveRecordEncryption(record, credentials, 'session');
            this.encryption.setSession(record.id, encryption);
            const session: Session = {
                id: record.id,
                seq: record.seq,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                active: record.active,
                activeAt: record.activeAt,
                metadata: decryptRecordField(record.metadata, encryption),
                metadataVersion: record.metadataVersion,
                agentState: decryptRecordField(record.agentState, encryption),
                agentStateVersion: record.agentStateVersion,
            };
            this.cache.set(session.id, session);
            return session;
        });
        return sessions;
    }

    async get(sessionId: string): Promise<Session> {
        this.requireId(sessionId, 'sessionId');
        const sessions = await this.list();
        const session = sessions.find(candidate => candidate.id === sessionId);
        if (!session) {
            throw new PawsAgentError('NOT_FOUND', 'Session not found', { details: { sessionId } });
        }
        return session;
    }

    async spawn(input: SpawnSessionInput): Promise<SpawnSessionResult> {
        this.requireId(input.machineId, 'machineId');
        this.requireId(input.directory, 'directory');
        await this.ensureMachine(input.machineId);
        const result = await this.realtime.machineRpc<unknown>(input.machineId, 'spawn-happy-session', {
            type: 'spawn-in-directory',
            directory: input.directory,
            approvedNewDirectoryCreation: input.approvedNewDirectoryCreation ?? false,
            token: input.providerToken,
            agent: input.agent,
        });
        return this.parseSpawnResult(result);
    }

    async resume(input: ResumeSessionInput): Promise<SpawnSessionResult> {
        const session = await this.get(input.sessionId);
        const metadata = session.metadata as { machineId?: unknown } | null;
        if (typeof metadata?.machineId !== 'string' || !metadata.machineId) {
            throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Session does not identify its machine');
        }
        await this.ensureMachine(metadata.machineId);
        const result = await this.realtime.machineRpc<unknown>(metadata.machineId, 'resume-happy-session', {
            sessionId: session.id,
        });
        return this.parseSpawnResult(result);
    }

    async stop(sessionId: string): Promise<void> {
        await this.ensureSession(sessionId);
        this.realtime.emit('session-end', { sid: sessionId, time: Date.now() });
    }

    getCached(sessionId: string): Session | undefined {
        return this.cache.get(sessionId);
    }

    private async ensureSession(sessionId: string): Promise<void> {
        if (this.encryption.getSession(sessionId)) return;
        await this.get(sessionId);
    }

    private async ensureMachine(machineId: string): Promise<void> {
        if (this.encryption.getMachine(machineId)) return;
        const machines = await this.listMachines();
        if (!machines.some(machine => machine.id === machineId)) {
            throw new PawsAgentError('NOT_FOUND', 'Machine not found', { details: { machineId } });
        }
    }

    private requireId(value: string, name: string): void {
        if (!value.trim()) {
            throw new PawsAgentError('INVALID_ARGUMENT', `${name} is required`);
        }
    }

    private parseSpawnResult(value: unknown): SpawnSessionResult {
        if (value == null || typeof value !== 'object' || Array.isArray(value)) {
            throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Machine RPC returned a malformed session result');
        }
        const result = value as Record<string, unknown>;
        if (result.type === 'success' && typeof result.sessionId === 'string' && result.sessionId.length > 0) {
            return { type: 'success', sessionId: result.sessionId };
        }
        if (
            result.type === 'requestToApproveDirectoryCreation'
            && typeof result.directory === 'string'
            && result.directory.length > 0
        ) {
            return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
        }
        if (result.type === 'error' && typeof result.errorMessage === 'string' && result.errorMessage.length > 0) {
            return { type: 'error', errorMessage: result.errorMessage };
        }
        throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Machine RPC returned a malformed session result');
    }
}
