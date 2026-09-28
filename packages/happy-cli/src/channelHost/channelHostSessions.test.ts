import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Metadata, Session } from '@/api/types';
import { readReconnectSessionEnvironment } from '@/daemon/reconnectSessionEnv';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

import { ChannelHostRequestError } from './channelHostSupervisor';
import { createChannelHostSessions } from './channelHostSessions';

const machine = {
    machineId: 'm-1', host: 'box', os: 'darwin', homeDir: '/home/u',
    happyHomeDir: '/home/u/.happy', happyLibDir: '/lib/happy', happyToolsDir: '/lib/happy/tools/unpacked', version: '1.0.0',
};

/** Opens an envelope the way an account holder does (ephemeral box to the content key). */
function openEnvelope(envelope: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
    const bundle = envelope.slice(1);
    const opened = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), secretKey);
    return opened ? new Uint8Array(opened) : null;
}

function setup(options: { legacy?: boolean; spawnedId?: string } = {}) {
    const account = tweetnacl.box.keyPair();
    const created: Array<{ tag: string; metadata: Metadata; dataKey: { key: Uint8Array; wrapped: Uint8Array } }> = [];
    const spawned: SpawnSessionOptions[] = [];
    const createSession = vi.fn(async (input: typeof created[number]): Promise<Session | null> => {
        created.push(input);
        return {
            id: 'session-1', seq: 0, metadata: input.metadata, metadataVersion: 1,
            agentState: null, agentStateVersion: 0, encryptionKey: input.dataKey.key, encryptionVariant: 'dataKey',
        };
    });
    const spawnSession = vi.fn(async (spawnOptions: SpawnSessionOptions): Promise<SpawnSessionResult> => {
        spawned.push(spawnOptions);
        return { type: 'success', sessionId: options.spawnedId ?? 'session-1' };
    });
    const sessions = createChannelHostSessions({
        accountEncryption: options.legacy
            ? { type: 'legacy', secret: new Uint8Array(32) }
            : { type: 'dataKey', publicKey: account.publicKey, machineKey: new Uint8Array(32) },
        machine,
        createSession,
        spawnSession,
    });
    return { sessions, account, created, spawned, createSession, spawnSession };
}

const spawnParams = {
    directory: '/work/project',
    agent: 'codex',
    environmentVariables: { FOO: 'bar' },
    mcpCallerGrantEnvelope: 'grant-envelope',
    createdByAccountId: 'acct-7',
    personalChatId: 'chat-1',
};

describe('createChannelHostSessions — spawn', () => {
    it('creates the session with a key it generated and hands the same key to the session child', async () => {
        const { sessions, account, created, spawned } = setup();

        const value = await sessions.handle('spawn', spawnParams) as { sessionId: string; dataEncryptionKey: string; dek: string };

        expect(value.sessionId).toBe('session-1');
        const dek = decodeBase64(value.dek);
        expect(dek).toHaveLength(32);
        // The envelope returned is the one uploaded, and it opens to the returned key.
        expect(value.dataEncryptionKey).toBe(encodeBase64(created[0].dataKey.wrapped));
        expect(openEnvelope(decodeBase64(value.dataEncryptionKey), account.secretKey)).toEqual(dek);
        expect(created[0].dataKey.key).toEqual(dek);

        // The child attaches to that session with that key instead of creating its own.
        const reconnect = readReconnectSessionEnvironment({ ...spawned[0].reconnectEnvironment });
        expect(reconnect?.id).toBe('session-1');
        expect(reconnect?.encryptionKey).toEqual(dek);
        expect(reconnect?.encryptionVariant).toBe('dataKey');
        expect(reconnect?.seq).toBe(0);
        expect(reconnect?.metadata.path).toBe('/work/project');
    });

    it('spawns with the requested directory, agent, environment, grant and requester, like spawn-happy-session', async () => {
        const { sessions, spawned, created } = setup();
        await sessions.handle('spawn', spawnParams);

        expect(spawned[0]).toMatchObject({
            directory: '/work/project',
            agent: 'codex',
            environmentVariables: { FOO: 'bar' },
            mcpCallerGrantEnvelope: 'grant-envelope',
            createdByAccountId: 'acct-7',
        });
        expect(created[0].metadata).toMatchObject({
            path: '/work/project', flavor: 'codex', machineId: 'm-1', startedBy: 'daemon',
            createdBy: { accountId: 'acct-7' },
        });
    });

    it('answers dek only for sessions it started for the host, with the same envelope and key', async () => {
        const { sessions } = setup();
        const spawnedValue = await sessions.handle('spawn', spawnParams) as Record<string, unknown>;

        await expect(sessions.handle('dek', { sessionId: 'session-1' })).resolves.toEqual({
            dataEncryptionKey: spawnedValue.dataEncryptionKey,
            dek: spawnedValue.dek,
        });
        await expect(sessions.handle('dek', { sessionId: 'someone-else' }))
            .rejects.toEqual(new ChannelHostRequestError('SESSION_UNKNOWN'));
    });

    it('returns null keys on a legacy account and spawns the ordinary way', async () => {
        const { sessions, createSession, spawned } = setup({ legacy: true });

        await expect(sessions.handle('spawn', { ...spawnParams, agent: 'gemini' }))
            .resolves.toEqual({ sessionId: 'session-1', dataEncryptionKey: null, dek: null });
        expect(createSession).not.toHaveBeenCalled();
        expect(spawned[0].reconnectEnvironment).toBeUndefined();
        await expect(sessions.handle('dek', { sessionId: 'session-1' }))
            .resolves.toEqual({ dataEncryptionKey: null, dek: null });
    });

    it('refuses an agent whose runner cannot attach to a session it did not create', async () => {
        const { sessions, createSession } = setup();
        await expect(sessions.handle('spawn', { ...spawnParams, agent: 'gemini' }))
            .rejects.toEqual(new ChannelHostRequestError('AGENT_UNSUPPORTED'));
        expect(createSession).not.toHaveBeenCalled();
    });

    it('refuses malformed params with a closed code', async () => {
        const { sessions } = setup();
        for (const params of [null, {}, { directory: '' }, { directory: '/w', environmentVariables: { A: 1 } },
            { directory: '/w', mcpCallerGrantEnvelope: 3 }, { directory: '/w', createdByAccountId: {} }]) {
            await expect(sessions.handle('spawn', params)).rejects.toEqual(new ChannelHostRequestError('INVALID_PARAMS'));
        }
        await expect(sessions.handle('dek', {})).rejects.toEqual(new ChannelHostRequestError('INVALID_PARAMS'));
        await expect(sessions.handle('unknown', {})).rejects.toEqual(new ChannelHostRequestError('METHOD_UNKNOWN'));
    });

    it('does not remember a key whose child ended up on another session or failed', async () => {
        const mismatch = setup({ spawnedId: 'other-session' });
        await expect(mismatch.sessions.handle('spawn', spawnParams))
            .rejects.toEqual(new ChannelHostRequestError('SESSION_MISMATCH'));
        await expect(mismatch.sessions.handle('dek', { sessionId: 'session-1' }))
            .rejects.toEqual(new ChannelHostRequestError('SESSION_UNKNOWN'));

        const failed = setup();
        failed.spawnSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'no' });
        await expect(failed.sessions.handle('spawn', spawnParams)).rejects.toEqual(new ChannelHostRequestError('SPAWN_FAILED'));

        const offline = setup();
        offline.createSession.mockResolvedValueOnce(null);
        await expect(offline.sessions.handle('spawn', spawnParams))
            .rejects.toEqual(new ChannelHostRequestError('SESSION_CREATE_FAILED'));
        expect(offline.spawnSession).not.toHaveBeenCalled();
    });
});
