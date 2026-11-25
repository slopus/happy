import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';
import { projectConversationSessions } from './conversationSession';
const mock = vi.hoisted(() => ({ sessions: {} as Record<string, Session>, refresh: vi.fn(), update: vi.fn(), delivery: vi.fn(), hydrate: vi.fn(), assert: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: mock.assert }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: mock.sessions, applySessions: (sessions: Session[]) => { for (const session of sessions) mock.sessions[session.id] = session; } }) } }));
vi.mock('./sync', () => ({ sync: { refreshConversationSession: mock.refresh, hasConversationHandoffDelivery: mock.delivery, ensureSessionHydrated: mock.hydrate } }));
vi.mock('./ops', () => ({ sessionUpdateMetadata: mock.update }));
import { assertConversationSourceIdle, assertConversationSendAllowed, prepareConversationSwitch, claimConversationSwitch, commitConversationSwitch, releaseConversationSwitch, recoverConversationSwitch } from './conversationSwitch';
const session = (id: string, metadata: object = {}): Session => ({ id, metadata: { path: '/project', host: 'mac', machineId: 'm', ...metadata }, metadataVersion: 1, thinking: false, agentState: null } as Session);
const record = { rootId: 'root', sourceId: 'root', targetId: 'target', requestId: 'switch-1' };
beforeEach(() => {
    vi.resetAllMocks();
    mock.sessions = { root: session('root'), target: session('target', { continuationOfSessionId: 'root' }) };
    mock.refresh.mockResolvedValue(true); mock.hydrate.mockResolvedValue(true); mock.delivery.mockResolvedValue(true);
    mock.update.mockImplementation(async (_id, metadata, version, apply) => ({ metadata: apply(metadata), version: version + 1 }));
});
describe('conversation handoff transaction', () => {
    it.each([
        { thinking: true }, { hasPendingLocalMessages: true }, { agentState: { turnStatus: { status: 'running' } } },
        { agentState: { queuedMessages: 1 } }, { agentState: { requests: { approval: {} } } },
    ])('rejects an active source before spawning: %j', state => {
        expect(() => assertConversationSourceIdle({ ...session('root'), ...state } as Session)).toThrow('session.agentSwitchBusy');
    });
    it('freshens authority before authorizing a switch and rejects a stale tab', async () => {
        mock.refresh.mockImplementationOnce(async () => { mock.sessions.root.metadata!.conversationActiveSessionId = 'other'; return true; });
        await expect(prepareConversationSwitch('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.update).not.toHaveBeenCalled();
    });
    it('keeps the source active until receipt confirmation, then rejects further source sends', async () => {
        await claimConversationSwitch(record);
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
        expect(() => assertConversationSendAllowed('root')).toThrow('session.agentSwitchPending');
        expect(() => assertConversationSendAllowed('target')).toThrow('session.agentSwitchPending');
        expect(() => assertConversationSendAllowed('target', record.requestId)).not.toThrow();
        await commitConversationSwitch(record);
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
        expect(() => assertConversationSendAllowed('root')).toThrow('session.agentSwitchChanged');
        expect(() => assertConversationSendAllowed('target')).not.toThrow();
    });
    it('rejects a second device claim when the CAS callback is rerun on newer metadata', async () => {
        mock.update.mockImplementation(async (id, metadata, version, apply) => ({
            metadata: apply(id === 'root' ? { ...metadata, conversationSwitch: { id: 'other', sourceSessionId: 'root', targetSessionId: 'other-target' } } : metadata), version: version + 1,
        }));
        await expect(claimConversationSwitch(record)).rejects.toThrow('session.agentSwitchPending');
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
    });
    it('detaches a losing unsent candidate while retaining its saved continuation context', async () => {
        mock.sessions.target.metadata!.continuationContext = 'Keep the parser task.';
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            if (id === 'root') throw new Error('root-claim-rejected');
            return { metadata: apply(metadata), version: version + 1 };
        });
        mock.refresh.mockImplementation(async (id: string) => {
            if (id === 'root') mock.sessions.root.metadata!.conversationSwitch = { id: 'other', sourceSessionId: 'root', targetSessionId: 'winner' };
            return true;
        });
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'detached' });
        expect(mock.refresh.mock.calls).toEqual([['root'], ['target']]);
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(mock.sessions.target.metadata).toMatchObject({ continuationOfSessionId: 'root', continuationContext: 'Keep the parser task.' });
        expect(mock.sessions.root.metadata!.conversationSwitch?.targetSessionId).toBe('winner');
    });
    it('accepts a lost root acknowledgement only when fresh candidate linkage also confirms the same predecessor', async () => {
        mock.sessions.target.metadata!.conversationRootSessionId = 'root';
        let remoteRoot: Session['metadata'];
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            const next = apply(metadata);
            if (id === 'root') { remoteRoot = next; throw new Error('acknowledgement-lost'); }
            return { metadata: next, version: version + 1 };
        });
        mock.refresh.mockImplementation(async (id: string) => {
            if (id === 'root') mock.sessions.root = { ...mock.sessions.root, metadata: remoteRoot!, metadataVersion: 2 };
            return true;
        });
        await expect(claimConversationSwitch(record)).resolves.toBeUndefined();
        expect(mock.refresh.mock.calls).toEqual([['root'], ['target']]);
        expect(mock.sessions.root.metadata!.conversationSwitch?.id).toBe(record.requestId);
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
    });
    it('keeps an independent candidate visible when both root CAS and authority reads fail', async () => {
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            if (id === 'root') throw new Error('transport-unknown');
            return { metadata: apply(metadata), version: version + 1 };
        });
        mock.refresh.mockRejectedValueOnce(new Error('offline'));
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'unknown' });
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(mock.update.mock.calls.filter(call => call[0] === 'target')).toHaveLength(0);
        expect(projectConversationSessions(mock.sessions).map(row => row.id)).toEqual(['root', 'target']);
    });
    it('retains a candidate referenced by a newer active pointer instead of unlinking it', async () => {
        mock.sessions.target.metadata!.conversationRootSessionId = 'root';
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            if (id === 'root') throw new Error('claim-changed');
            return { metadata: apply(metadata), version: version + 1 };
        });
        mock.refresh.mockImplementationOnce(async () => { mock.sessions.root.metadata!.conversationActiveSessionId = 'target'; return true; });
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'retained' });
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.refresh).toHaveBeenCalledExactlyOnceWith('root');
    });
    it('does not overwrite candidate membership moved to another chat during a rollback CAS retry', async () => {
        mock.sessions.target.metadata!.conversationRootSessionId = 'root';
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            if (id === 'root') throw new Error('claim-rejected');
            return { metadata: apply({ ...metadata, conversationRootSessionId: 'different-root' }), version: version + 1 };
        });
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'detached' });
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('different-root');
    });
    it('confirms a lost candidate-link acknowledgement only under the persisted root reservation', async () => {
        let targetUpdates = 0; let linkedMetadata: Session['metadata'];
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            const next = apply(metadata);
            if (id === 'target' && ++targetUpdates === 1) { linkedMetadata = next; throw new Error('link-acknowledgement-lost'); }
            return { metadata: next, version: version + 1 };
        });
        mock.refresh.mockImplementation(async (id: string) => {
            if (id === 'target') mock.sessions.target = { ...mock.sessions.target, metadata: linkedMetadata!, metadataVersion: 2 };
            return true;
        });
        await expect(claimConversationSwitch(record)).resolves.toBeUndefined();
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.update.mock.calls.filter(call => call[0] === 'root')).toHaveLength(1);
        expect(mock.update.mock.calls.map(call => call[0])).toEqual(['root', 'target']);
    });
    it('reserves the root before linking and lets the original request repair a rejected candidate link', async () => {
        let failTarget = true;
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            if (id === 'target' && failTarget) throw new Error('candidate-link-rejected');
            return { metadata: apply(metadata), version: version + 1 };
        });
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'retained' });
        expect(mock.update.mock.calls.map(call => call[0])).toEqual(['root', 'target']);
        expect(mock.sessions.root.metadata!.conversationSwitch?.id).toBe(record.requestId);
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(() => assertConversationSendAllowed('target', record.requestId)).toThrow('session.agentSwitchPending');
        failTarget = false;
        await expect(claimConversationSwitch(record)).resolves.toBeUndefined();
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(() => assertConversationSendAllowed('target', record.requestId)).not.toThrow();
    });
    it('recovers a lost root acknowledgement with an unlinked candidate without ever inferring prompt delivery', async () => {
        let remoteRoot: Session['metadata'];
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            const next = apply(metadata);
            if (id === 'root' && !remoteRoot) { remoteRoot = next; throw new Error('root-acknowledgement-lost'); }
            return { metadata: next, version: version + 1 };
        });
        mock.refresh.mockImplementation(async (id: string) => {
            if (id === 'root') mock.sessions.root = { ...mock.sessions.root, metadata: remoteRoot!, metadataVersion: 2 };
            return true;
        });
        await expect(claimConversationSwitch(record)).rejects.toMatchObject({ candidateState: 'retained' });
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(() => assertConversationSendAllowed('target', record.requestId)).toThrow('session.agentSwitchPending');
        mock.delivery.mockResolvedValueOnce(false);
        await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchPending');
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.sessions.root.metadata).not.toHaveProperty('conversationActiveSessionId');
        expect(mock.delivery).toHaveBeenCalledWith('target', 'root');
        expect(await recoverConversationSwitch('root')).toBe(true);
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
    });
    it('never repairs a reserved target with an unrelated saved predecessor', async () => {
        mock.sessions.root.metadata!.conversationSwitch = { id: record.requestId, sourceSessionId: 'root', targetSessionId: 'target' };
        mock.sessions.target.metadata!.continuationOfSessionId = 'different-source';
        await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(mock.delivery).not.toHaveBeenCalled();
    });
    it('retries the same claim/commit without duplicating metadata or taking a newer executor', async () => {
        await claimConversationSwitch(record); await claimConversationSwitch(record);
        await commitConversationSwitch(record); await commitConversationSwitch(record);
        mock.sessions.root.metadata!.conversationActiveSessionId = 'newer';
        await expect(commitConversationSwitch(record)).rejects.toThrow('session.agentSwitchChanged');
    });
    it('detaches an explicitly released unsent candidate so it does not remain hidden outside the committed chain', async () => {
        await claimConversationSwitch(record);
        await releaseConversationSwitch(record);
        expect(mock.sessions.root.metadata).not.toHaveProperty('conversationSwitch');
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        expect(mock.sessions.target.metadata!.continuationOfSessionId).toBe('root');
        expect(() => assertConversationSendAllowed('root')).not.toThrow();
    });
    it('finishes a reload from delivery evidence without sending another prompt', async () => {
        await claimConversationSwitch(record);
        expect(await recoverConversationSwitch('root')).toBe(true);
        expect(mock.delivery).toHaveBeenCalledWith('target', 'root');
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
    });
    it('keeps an uncertain handoff reserved and never infers delivery from an empty page', async () => {
        await claimConversationSwitch(record); mock.delivery.mockResolvedValue(false);
        await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchPending');
        expect(mock.sessions.root.metadata!.conversationSwitch?.id).toBe(record.requestId);
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
    });
    it('refuses delivery evidence from a target linked to another conversation', async () => {
        await claimConversationSwitch(record); mock.sessions.target.metadata!.conversationRootSessionId = 'unrelated';
        await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.delivery).not.toHaveBeenCalled();
    });
});
