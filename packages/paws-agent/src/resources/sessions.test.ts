import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, encryptLegacy } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
import { SessionsResourceImpl } from './sessions';

const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
const credentials = {
    token: 'token',
    secret,
    contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
};

describe('SessionsResource', () => {
    it('Codex 启动前申请机器绑定的一次性授权，并传给加密 RPC', async () => {
        const grant = 'a'.repeat(43);
        const transport = { post: vi.fn().mockResolvedValue({ grant }) };
        const realtime = { machineRpc: vi.fn().mockResolvedValue({ type: 'success', sessionId: 's1' }) };
        const sessions = new SessionsResourceImpl(transport as never, realtime as never, new RecordEncryptionStore(), vi.fn().mockResolvedValue([{ id: 'm1' }]));
        await sessions.spawn({ machineId: 'm1', directory: '/project', agent: 'codex' });
        expect(transport.post).toHaveBeenCalledWith('/v1/codex-session-grants', { machineId: 'm1' });
        expect(realtime.machineRpc).toHaveBeenCalledWith('m1', 'spawn-happy-session', expect.objectContaining({ codexSessionGrant: grant }));
        expect(transport.post.mock.invocationCallOrder[0]).toBeLessThan(realtime.machineRpc.mock.invocationCallOrder[0]);
    });

    it.each([null, {}, { grant: '' }, { grant: 'x'.repeat(42) }, { grant: '!'.repeat(43) }])('授权响应不合法时不启动进程 %j', async response => {
        const transport = { post: vi.fn().mockResolvedValue(response) };
        const realtime = { machineRpc: vi.fn().mockResolvedValue({ type: 'success', sessionId: 's1' }) };
        const sessions = new SessionsResourceImpl(transport as never, realtime as never, new RecordEncryptionStore(), vi.fn().mockResolvedValue([{ id: 'm1' }]));
        await expect(sessions.spawn({ machineId: 'm1', directory: '/project', agent: 'codex' })).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
        expect(realtime.machineRpc).not.toHaveBeenCalled();
    });

    it('授权接口失败时不回退为未授权启动', async () => {
        const transport = { post: vi.fn().mockRejectedValue(new Error('grant failed')) };
        const realtime = { machineRpc: vi.fn().mockResolvedValue({ type: 'success', sessionId: 's1' }) };
        const sessions = new SessionsResourceImpl(transport as never, realtime as never, new RecordEncryptionStore(), vi.fn().mockResolvedValue([{ id: 'm1' }]));
        await expect(sessions.spawn({ machineId: 'm1', directory: '/project', agent: 'codex' })).rejects.toThrow('grant failed');
        expect(realtime.machineRpc).not.toHaveBeenCalled();
    });

    it('loads the active snapshot and keeps encryption material private', async () => {
        const transport = {
            getWithCredentials: vi.fn().mockResolvedValue({
                data: { sessions: [{
                    id: 'session-1', seq: 1, createdAt: 2, updatedAt: 3,
                    active: true, activeAt: 4,
                    metadata: encodeBase64(encryptLegacy({ machineId: 'machine-1' }, secret)),
                    metadataVersion: 5,
                    agentState: encodeBase64(encryptLegacy({ requests: {} }, secret)),
                    agentStateVersion: 6,
                    dataEncryptionKey: null,
                }] },
                credentials,
            }),
        };
        const sessions = new SessionsResourceImpl(
            transport as never,
            {} as never,
            new RecordEncryptionStore(),
            vi.fn(),
        );

        const result = await sessions.list({ active: true });
        expect(transport.getWithCredentials).toHaveBeenCalledWith('/v2/sessions/active');
        expect(result[0]).toMatchObject({
            id: 'session-1',
            metadata: { machineId: 'machine-1' },
            agentState: { requests: {} },
        });
        expect(JSON.stringify(result)).not.toContain('dataEncryptionKey');
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it.each([
        null,
        {},
        { type: 'success' },
        { type: 'requestToApproveDirectoryCreation' },
        { type: 'error' },
        { type: 'unexpected', sessionId: 'session-1' },
    ])('rejects malformed spawn RPC results: %j', async malformed => {
        const realtime = { machineRpc: vi.fn().mockResolvedValue(malformed) };
        const sessions = new SessionsResourceImpl(
            {} as never,
            realtime as never,
            new RecordEncryptionStore(),
            vi.fn().mockResolvedValue([{ id: 'machine-1' }]),
        );

        await expect(sessions.spawn({ machineId: 'machine-1', directory: '/tmp/project' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    });

    it.each([
        { type: 'success', sessionId: 'session-1' },
        { type: 'requestToApproveDirectoryCreation', directory: '/tmp/new' },
        { type: 'error', errorMessage: 'failed' },
    ])('accepts a valid spawn RPC result: %j', async result => {
        const realtime = { machineRpc: vi.fn().mockResolvedValue(result) };
        const sessions = new SessionsResourceImpl(
            {} as never,
            realtime as never,
            new RecordEncryptionStore(),
            vi.fn().mockResolvedValue([{ id: 'machine-1' }]),
        );

        await expect(sessions.spawn({ machineId: 'machine-1', directory: '/tmp/project' }))
            .resolves.toEqual(result);
    });
});

it('terminate stops the owning daemon process without deleting conversation history', async () => {
    const transport = { getWithCredentials: vi.fn().mockResolvedValue({credentials, data:{session:{id:'s1', metadata:encodeBase64(encryptLegacy({machineId:'m1'},secret)), agentState:null, dataEncryptionKey:null}}}) };
    const realtime = {sessionRpc:vi.fn().mockResolvedValue({success:true}),emit:vi.fn()};
    const sessions=new SessionsResourceImpl(transport as never,realtime as never,new RecordEncryptionStore(),vi.fn().mockResolvedValue([{id:'m1'}]));
    await sessions.terminate('s1');
    expect(realtime.sessionRpc).toHaveBeenCalledWith('s1','killSession',{});
    expect(realtime.emit).not.toHaveBeenCalled();
});
