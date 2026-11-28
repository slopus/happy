import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(), refresh: vi.fn(), assertAccount: vi.fn(), permission: vi.fn(), model: vi.fn(), effort: vi.fn(),
    sessions: {} as Record<string, any>, settings: {} as any,
}));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('./sync', () => ({ sync: { refreshConversationSession: mocks.refresh } }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: mocks.assertAccount }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: mocks.sessions, settings: mocks.settings,
    updateSessionPermissionMode: mocks.permission, updateSessionModelMode: mocks.model, updateSessionEffortLevel: mocks.effort }) } }));
import { sessionPrepareConversation } from './ops';

const record = { rootId: 'root', sourceId: 'source', targetId: 'target', requestId: '00000000-0000-4000-8000-000000000010' };
const contextId = '00000000-0000-4000-8000-000000000011';
const configuration = { agent: 'antigravity' as const, permissionMode: 'default', modelMode: 'native-model', effortLevel: 'high' };
const receipt = () => ({ ready: true, agent: 'antigravity', sessionId: record.targetId, hostPid: 321,
    rootSessionId: record.rootId, sourceSessionId: record.sourceId, requestId: record.requestId,
    contextId, contextSha256: 'a'.repeat(64), model: 'native-model', effort: 'high', permissionMode: 'default' });

beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings = { agentDefaultOverrides: { antigravity: { permissionMode: 'default' }, codex: { permissionMode: 'read-only' } } };
    mocks.sessions = {
        root: { metadata: { conversationActiveSessionId: 'source', conversationSwitch: { id: record.requestId, sourceSessionId: 'source', targetSessionId: 'target' } } },
        source: { permissionMode: 'yolo', metadata: { currentOperatingModeCode: 'yolo' } },
        target: { permissionMode: 'bypassPermissions', metadata: { hostPid: 321, flavor: 'antigravity',
            parentSessionId: 'source', crossAgentRequestId: record.requestId,
            currentModelCode: 'native-model', currentThoughtLevelCode: 'high', acpPermissionMode: 'default',
            conversationRootSessionId: 'root', continuationOfSessionId: 'source', portableContext: { id: contextId, sha256: 'a'.repeat(64) } } },
    };
    mocks.refresh.mockResolvedValue(true);
    mocks.rpc.mockImplementation(async () => receipt());
});

describe('conversation native preparation RPC', () => {
    it('surfaces the worker error envelope before validating a readiness receipt, without saving configuration', async () => {
        mocks.rpc.mockResolvedValue({ error: 'Native Codex automatic approval is unsupported; select confirmation or full access.' });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow('Native Codex automatic approval is unsupported; select confirmation or full access.');
        expect(mocks.permission).not.toHaveBeenCalled();
        expect(mocks.model).not.toHaveBeenCalled();
        expect(mocks.effort).not.toHaveBeenCalled();
    });

    it('reports an invalid readiness receipt without exposing the schema diagnostic array', async () => {
        mocks.rpc.mockResolvedValue({ ready: true });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow('Target runtime did not provide a valid readiness acknowledgement.');
        expect(mocks.permission).not.toHaveBeenCalled();
        expect(mocks.model).not.toHaveBeenCalled();
        expect(mocks.effort).not.toHaveBeenCalled();
    });

    it('makes one bounded request for this worker and archive before saving acknowledged configuration', async () => {
        await sessionPrepareConversation(record, configuration);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('target', 'conversation-prepare', {
            rootSessionId: 'root', sourceSessionId: 'source', requestId: record.requestId,
            expectedWorkerPid: 321, contextId, contextSha256: 'a'.repeat(64),
            model: 'native-model', effort: 'high', permissionMode: 'default',
        }, { timeoutMs: 75_000, overallTimeoutMs: 75_000, isCurrent: expect.any(Function) });
        expect(mocks.permission).toHaveBeenCalledWith('target', 'default');
        expect(mocks.model).toHaveBeenCalledWith('target', 'native-model');
        expect(mocks.effort).toHaveBeenCalledWith('target', 'high');
        const isCurrent = mocks.rpc.mock.calls[0][3].isCurrent;
        expect(isCurrent()).toBe(true);
        delete mocks.sessions.root.metadata.conversationSwitch;
        expect(isCurrent()).toBe(false);
    });

    it.each([undefined, null])('uses target defaults for absent permission (%s), preserving source full access', async permissionMode => {
        await sessionPrepareConversation(record, { agent: 'antigravity', permissionMode });
        expect(mocks.rpc.mock.calls[0][2]).toMatchObject({ permissionMode: 'default' });
        expect(mocks.rpc.mock.calls[0][2]).not.toHaveProperty('model');
        expect(mocks.rpc.mock.calls[0][2]).not.toHaveProperty('effort');
        expect(mocks.sessions.source.permissionMode).toBe('yolo');
    });

    it('preserves an explicit staged permission and lets native select an unspecified model and effort', async () => {
        mocks.sessions.target.metadata.flavor = 'codex';
        mocks.sessions.target.metadata.currentOperatingModeCode = 'acceptEdits';
        mocks.rpc.mockResolvedValue({ ...receipt(), agent: 'codex', permissionMode: 'acceptEdits' });
        await sessionPrepareConversation(record, { agent: 'codex', permissionMode: 'acceptEdits', modelMode: 'default', effortLevel: 'default' });
        expect(mocks.rpc.mock.calls[0][2]).toMatchObject({ permissionMode: 'acceptEdits' });
        expect(mocks.rpc.mock.calls[0][2]).not.toHaveProperty('model');
        expect(mocks.permission).toHaveBeenCalledWith('target', 'acceptEdits');
    });

    it('rejects a historical unsupported Codex mode before making a native preparation request', async () => {
        mocks.sessions.target.metadata.flavor = 'codex';
        await expect(sessionPrepareConversation(record, { agent: 'codex', permissionMode: 'safe-yolo' })).rejects.toThrow('agentInput.taskPermission.chooseSupported');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.permission).not.toHaveBeenCalled();
    });

    it.each(['refresh', 'rpc'] as const)('rejects account changes during %s without saving configuration', async phase => {
        if (phase === 'refresh') mocks.refresh.mockImplementation(async () => {
            mocks.assertAccount.mockImplementation(() => { throw new Error('Account changed'); }); return true;
        });
        else mocks.rpc.mockImplementation(async () => {
            mocks.assertAccount.mockImplementation(() => { throw new Error('Account changed'); }); return receipt();
        });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow('Account changed');
        expect(mocks.permission).not.toHaveBeenCalled();
        if (phase === 'refresh') expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it.each(['parentSessionId', 'crossAgentRequestId', 'conversationRootSessionId', 'continuationOfSessionId'] as const)
    ('rejects a changed candidate %s before native configuration', async key => {
        mocks.sessions.target.metadata[key] = 'foreign';
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow();
        expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.permission).not.toHaveBeenCalled();
    });

    it.each(['application', 'delegatedTask', 'conversationDeletePlan', 'lifecycleState'] as const)
    ('rejects a candidate with incompatible %s', async key => {
        mocks.sessions.target.metadata[key] = key === 'lifecycleState' ? 'archiveRequested' : { id: 'foreign' };
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it.each(['sessionId', 'hostPid', 'agent', 'rootSessionId', 'sourceSessionId', 'requestId', 'contextId', 'contextSha256', 'permissionMode', 'model', 'effort'] as const)
    ('rejects a mismatched %s acknowledgement without saving it', async key => {
        mocks.rpc.mockResolvedValue({ ...receipt(), [key]: key === 'hostPid' ? 322 : key === 'requestId' || key === 'contextId'
            ? '00000000-0000-4000-8000-000000000099' : key === 'contextSha256' ? 'b'.repeat(64) : 'foreign' });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow();
        expect(mocks.permission).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
    });

    it.each(['worker', 'reservation', 'context'] as const)('rejects an acknowledgement after the %s changed', async key => {
        mocks.rpc.mockImplementation(async () => {
            if (key === 'worker') mocks.sessions.target.metadata.hostPid++;
            else if (key === 'context') mocks.sessions.target.metadata.portableContext.sha256 = 'b'.repeat(64);
            else delete mocks.sessions.root.metadata.conversationSwitch;
            return receipt();
        });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow(/changed/);
        expect(mocks.permission).not.toHaveBeenCalled();
    });

    it.each(['currentModelCode', 'currentThoughtLevelCode', 'acpPermissionMode'] as const)
    ('requires the native %s acknowledgement to remain current in the fresh target metadata', async key => {
        mocks.rpc.mockImplementation(async () => { mocks.sessions.target.metadata[key] = 'foreign'; return receipt(); });
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow(/configuration.*changed/);
        expect(mocks.permission).not.toHaveBeenCalled();
    });

    it('fails explicitly for an older worker without replay or a saved acknowledgement', async () => {
        mocks.rpc.mockRejectedValue(new Error('RPC handler not found'));
        await expect(sessionPrepareConversation(record, configuration)).rejects.toThrow('RPC handler not found');
        expect(mocks.rpc).toHaveBeenCalledOnce(); expect(mocks.permission).not.toHaveBeenCalled();
    });
});
