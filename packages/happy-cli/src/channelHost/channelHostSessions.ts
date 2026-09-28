/**
 * The channel host's session requests, answered by the daemon (Saycode specs/happy-cli-channel-host
 * — T3 in phase0-results, plan D10).
 *
 * The host serves only sessions this daemon runs, and it has to read them: it gets their data key
 * from here. So for a host spawn the daemon, not the session child, makes the key. It creates the
 * session record itself, sealed with a key it generated and wrapped to the account public key (the
 * parent-creates-session order of the managed runtime), then starts the child on that session with
 * the HAPPY_RECONNECT_* handoff a resume already uses — the child attaches instead of minting a key
 * of its own. The key is remembered only for sessions started this way, and only in memory.
 *
 * Only the Claude and Codex runners honour the reconnect handoff; any other agent would create a
 * second session under its own key, so it is refused rather than half-served. A legacy account has
 * no per-session key — the host already holds the account secret — so its spawns take the ordinary
 * path and report null keys.
 */
import { randomUUID } from 'node:crypto';

import { encodeBase64, getRandomBytes, wrapDataEncryptionKey } from '@/api/encryption';
import type { Metadata, Session } from '@/api/types';
import { buildReconnectSessionEnvironment } from '@/daemon/reconnectSessionEnv';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { Credentials } from '@/persistence';

import { ChannelHostRequestError } from './channelHostSupervisor';

type SessionKeys = { dataEncryptionKey: string | null; dek: string | null };

const RECONNECTING_AGENTS = new Set(['claude', 'codex']);
const KNOWN_AGENTS = new Set(['claude', 'codex', 'gemini', 'grok', 'openclaw', 'opencode']);

type SpawnRequest = {
    directory: string;
    agent: NonNullable<SpawnSessionOptions['agent']>;
    environmentVariables?: Record<string, string>;
    mcpCallerGrantEnvelope?: string;
    createdByAccountId?: string;
};

function optionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function readSpawnRequest(params: unknown): SpawnRequest {
    const invalid = new ChannelHostRequestError('INVALID_PARAMS');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid;
    const { directory, agent = 'claude', environmentVariables, mcpCallerGrantEnvelope, createdByAccountId } = params as Record<string, unknown>;
    if (typeof directory !== 'string' || directory.length === 0) throw invalid;
    if (typeof agent !== 'string' || !KNOWN_AGENTS.has(agent)) throw invalid;
    if (!optionalString(mcpCallerGrantEnvelope) || !optionalString(createdByAccountId)) throw invalid;
    if (environmentVariables !== undefined && (
        !environmentVariables || typeof environmentVariables !== 'object' || Array.isArray(environmentVariables)
        || !Object.values(environmentVariables).every((value) => typeof value === 'string')
    )) throw invalid;
    return {
        directory,
        agent: agent as SpawnRequest['agent'],
        environmentVariables: environmentVariables as Record<string, string> | undefined,
        mcpCallerGrantEnvelope,
        createdByAccountId,
    };
}

export function createChannelHostSessions(deps: {
    accountEncryption: Credentials['encryption'];
    /** This machine, for the metadata of a session the daemon creates. */
    machine: {
        machineId: string;
        host: string;
        os: string;
        homeDir: string;
        happyHomeDir: string;
        happyLibDir: string;
        happyToolsDir: string;
        version: string;
    };
    createSession: (input: { tag: string; metadata: Metadata; dataKey: { key: Uint8Array; wrapped: Uint8Array } }) => Promise<Session | null>;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
}): { handle(method: string, params: unknown): Promise<unknown> } {
    const keys = new Map<string, SessionKeys>();

    const spawnOptions = (request: SpawnRequest): SpawnSessionOptions => ({
        directory: request.directory,
        agent: request.agent,
        environmentVariables: request.environmentVariables,
        mcpCallerGrantEnvelope: request.mcpCallerGrantEnvelope,
        createdByAccountId: request.createdByAccountId,
    });

    const startedSessionId = (result: SpawnSessionResult): string => {
        if (result.type !== 'success') throw new ChannelHostRequestError('SPAWN_FAILED');
        return result.sessionId;
    };

    const spawn = async (params: unknown) => {
        const request = readSpawnRequest(params);
        const encryption = deps.accountEncryption;
        if (encryption.type !== 'dataKey') {
            const sessionId = startedSessionId(await deps.spawnSession(spawnOptions(request)));
            const none: SessionKeys = { dataEncryptionKey: null, dek: null };
            keys.set(sessionId, none);
            return { sessionId, ...none };
        }
        if (!RECONNECTING_AGENTS.has(request.agent)) throw new ChannelHostRequestError('AGENT_UNSUPPORTED');

        const key = getRandomBytes(32);
        const wrapped = wrapDataEncryptionKey(key, encryption.publicKey);
        const metadata: Metadata = {
            path: request.directory,
            host: deps.machine.host,
            version: deps.machine.version,
            os: deps.machine.os,
            machineId: deps.machine.machineId,
            homeDir: deps.machine.homeDir,
            happyHomeDir: deps.machine.happyHomeDir,
            happyLibDir: deps.machine.happyLibDir,
            happyToolsDir: deps.machine.happyToolsDir,
            flavor: request.agent,
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
            ...(request.createdByAccountId ? { createdBy: { accountId: request.createdByAccountId } } : {}),
        };
        let session: Session | null;
        try {
            session = await deps.createSession({ tag: randomUUID(), metadata, dataKey: { key, wrapped } });
        } catch {
            throw new ChannelHostRequestError('SESSION_CREATE_FAILED');
        }
        if (!session) throw new ChannelHostRequestError('SESSION_CREATE_FAILED');

        const reconnectEnvironment = buildReconnectSessionEnvironment({
            sessionId: session.id,
            encryption: {
                encryptionKey: key,
                encryptionVariant: 'dataKey',
                seq: session.seq,
                metadataVersion: session.metadataVersion,
                agentStateVersion: session.agentStateVersion,
            },
            serverSnapshot: {
                metadata: session.metadata,
                seq: session.seq,
                metadataVersion: session.metadataVersion,
                agentStateVersion: session.agentStateVersion,
            },
            baselineSeq: session.seq,
        });
        const sessionId = startedSessionId(await deps.spawnSession({ ...spawnOptions(request), reconnectEnvironment }));
        // The child reports the session it attached to. Anything else means the key the host would
        // be given does not open the session it would be told about.
        if (sessionId !== session.id) throw new ChannelHostRequestError('SESSION_MISMATCH');

        const sessionKeys: SessionKeys = { dataEncryptionKey: encodeBase64(wrapped), dek: encodeBase64(key) };
        keys.set(sessionId, sessionKeys);
        return { sessionId, ...sessionKeys };
    };

    const dek = async (params: unknown) => {
        const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ChannelHostRequestError('INVALID_PARAMS');
        const known = keys.get(sessionId);
        if (!known) throw new ChannelHostRequestError('SESSION_UNKNOWN');
        return { ...known };
    };

    return {
        async handle(method, params) {
            if (method === 'spawn') return spawn(params);
            if (method === 'dek') return dek(params);
            throw new ChannelHostRequestError('METHOD_UNKNOWN');
        },
    };
}
