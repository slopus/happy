import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataSchema, type Session } from './storageTypes';
import { projectConversationSessions } from './conversationSession';
const mock = vi.hoisted(() => ({ sessions: {} as Record<string, Session>, refresh: vi.fn(), update: vi.fn(), delivery: vi.fn(), hydrate: vi.fn(), assert: vi.fn(), cancel: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: mock.assert }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: mock.sessions, applySessions: (sessions: Session[]) => { for (const session of sessions) mock.sessions[session.id] = session; } }) } }));
vi.mock('./sync', () => ({ sync: { refreshConversationSession: mock.refresh, hasConversationHandoffDelivery: mock.delivery, ensureSessionHydrated: mock.hydrate } }));
vi.mock('./ops', () => ({ sessionUpdateMetadata: mock.update, machineCancelConversationLaunch: mock.cancel }));
import { assertConversationSourceIdle, assertConversationSendAllowed, prepareConversationSwitch, claimConversationSwitch, commitConversationSwitch, releaseConversationSwitch, recoverConversationSwitch, repairCommittedConversationMembership } from './conversationSwitch';
const session = (id: string, metadata: object = {}): Session => ({ id, metadata: { path: '/project', host: 'mac', machineId: 'm', ...metadata }, metadataVersion: 1, thinking: false, agentState: null } as Session);
const record = { rootId: 'root', sourceId: 'root', targetId: 'target', requestId: 'switch-1' };
beforeEach(() => {
    vi.resetAllMocks();
    mock.sessions = { root: session('root'), target: session('target', { continuationOfSessionId: 'root' }) };
    mock.cancel.mockResolvedValue({ success: false, error: 'unknown' });
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


describe('committed conversation membership recovery', () => {
    function stripWithOldReader(id: string) {
        const current = mock.sessions[id];
        // A deployed pre-conversation reader strips new fields, then writes its
        // ordinary first-message clock with the latest metadata version.
        const oldReader = MetadataSchema.omit({ conversationRootSessionId: true,
            conversationActiveSessionId: true, conversationSwitch: true, conversationDeletePlan: true }).strip();
        mock.sessions[id] = { ...current, metadata: { ...oldReader.parse(current.metadata), lastUserMessageAt: 20 }, metadataVersion: current.metadataVersion + 1 };
    }
    it('revalidates and restores a reservation stripped by the first-message clock before publishing active', async () => {
        await claimConversationSwitch(record);
        stripWithOldReader('target');
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
        mock.update.mockImplementation(async (id, metadata, version, apply) => {
            const next = apply(metadata);
            if (id === 'root' && next.conversationActiveSessionId === 'target') {
                expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
            }
            return { metadata: next, version: version + 1 };
        });
        await commitConversationSwitch(record);
        expect(mock.sessions.target.metadata).toMatchObject({ conversationRootSessionId: 'root', continuationOfSessionId: 'root', lastUserMessageAt: 20 });
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
    });
    it('repairs a committed missing hint through fresh authority without replaying delivery', async () => {
        await claimConversationSwitch(record); await commitConversationSwitch(record);
        stripWithOldReader('target'); mock.refresh.mockClear(); mock.update.mockClear(); mock.delivery.mockClear();
        expect(await repairCommittedConversationMembership('root')).toBe(true);
        expect(mock.refresh.mock.calls).toEqual([['root'], ['target']]);
        expect(mock.update.mock.calls.map(call => call[0])).toEqual(['target']);
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
        expect(mock.delivery).not.toHaveBeenCalled();
    });
    it('recovers a later handoff after an old reader strips the committed source hint', async () => {
        await claimConversationSwitch(record); await commitConversationSwitch(record);
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        const next = { rootId: 'root', sourceId: 'target', targetId: 'third', requestId: 'switch-2' };
        await claimConversationSwitch(next);
        stripWithOldReader('target');
        expect(await recoverConversationSwitch('root')).toBe(true);
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('third');
        expect(mock.sessions.root.metadata).not.toHaveProperty('conversationSwitch');
    });
    it('refuses a later handoff when its committed source has an explicit foreign binding', async () => {
        await claimConversationSwitch(record); await commitConversationSwitch(record);
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        await claimConversationSwitch({ rootId: 'root', sourceId: 'target', targetId: 'third', requestId: 'switch-2' });
        mock.sessions.target.metadata!.conversationRootSessionId = 'foreign';
        await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBe('target');
    });
    it('repairs all missing hints only after loading the full predecessor chain', async () => {
        mock.sessions.root.metadata!.conversationActiveSessionId = 'third';
        mock.sessions.target.metadata!.continuationOfSessionId = 'root';
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        const reads: string[] = [];
        mock.refresh.mockImplementation(async (id: string) => { reads.push(id); return true; });
        mock.update.mockImplementation(async (_id, metadata, version, apply) => {
            expect(reads).toEqual(['root', 'third', 'target']);
            return { metadata: apply(metadata), version: version + 1 };
        });
        expect(await recoverConversationSwitch('root')).toBe(true);
        expect(mock.sessions.target.metadata!.conversationRootSessionId).toBe('root');
        expect(mock.sessions.third.metadata!.conversationRootSessionId).toBe('root');
    });
    it.each([
        { conversationRootSessionId: 'foreign' }, { conversationActiveSessionId: 'other' },
        { machineId: 'different-machine' }, { path: '/different' },
    ])('fails closed before any write when a predecessor conflicts: %j', conflict => {
        mock.sessions.root.metadata!.conversationActiveSessionId = 'third';
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        mock.sessions.target.metadata = { ...mock.sessions.target.metadata!, ...conflict };
        return expect(repairCommittedConversationMembership('root')).rejects.toThrow('session.agentSwitchChanged').then(() => {
            expect(mock.update).not.toHaveBeenCalled();
            expect(mock.sessions.third.metadata).not.toHaveProperty('conversationRootSessionId');
        });
    });
    it('rejects a cycle or missing predecessor without partially repairing the visible target', async () => {
        mock.sessions.root.metadata!.conversationActiveSessionId = 'third';
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        mock.sessions.target.metadata!.continuationOfSessionId = 'third';
        await expect(repairCommittedConversationMembership('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.update).not.toHaveBeenCalled();
        mock.sessions.target.metadata!.continuationOfSessionId = 'missing';
        await expect(repairCommittedConversationMembership('root')).rejects.toThrow('session.agentSwitchUnavailable');
        expect(mock.update).not.toHaveBeenCalled();
    });
    it('refuses two authoritative roots claiming the same missing-hint target before any repair', async () => {
        mock.sessions.root.metadata!.conversationActiveSessionId = 'target';
        mock.sessions.otherRoot = session('otherRoot', { conversationActiveSessionId: 'target' });
        await expect(repairCommittedConversationMembership('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.update).not.toHaveBeenCalled();
        expect(mock.sessions.target.metadata).not.toHaveProperty('conversationRootSessionId');
    });
    it('does not repair an old chain after its root changes while predecessor reads are pending', async () => {
        mock.sessions.root.metadata!.conversationActiveSessionId = 'third';
        mock.sessions.third = session('third', { continuationOfSessionId: 'target' });
        mock.refresh.mockImplementation(async (id: string) => {
            if (id === 'target') mock.sessions.root.metadata!.conversationActiveSessionId = 'newer';
            return true;
        });
        await expect(repairCommittedConversationMembership('root')).rejects.toThrow('session.agentSwitchChanged');
        expect(mock.update).not.toHaveBeenCalled();
    });
});

it('reserves before native spawn, blocks ordinary sends, then binds only its own returned target', async () => {
    const { reserveConversationSwitch } = await import('./conversationSwitch');
    const reservation = { rootId: record.rootId, sourceId: record.sourceId, requestId: record.requestId };
    await reserveConversationSwitch(reservation);
    expect(mock.sessions.root.metadata!.conversationSwitch).toEqual({ id: record.requestId, sourceSessionId: record.sourceId });
    expect(() => assertConversationSendAllowed('root')).toThrow('session.agentSwitchPending');
    await claimConversationSwitch(record);
    expect(mock.sessions.root.metadata!.conversationSwitch?.targetSessionId).toBe('target');
    expect(() => assertConversationSendAllowed('target', record.requestId)).not.toThrow();
});

it('never releases a bound reservation as a pre-spawn failure', async () => {
    const { reserveConversationSwitch, releaseConversationSwitchReservation } = await import('./conversationSwitch');
    const reservation = { rootId: record.rootId, sourceId: record.sourceId, requestId: record.requestId };
    await reserveConversationSwitch(reservation);
    await claimConversationSwitch(record);
    await expect(releaseConversationSwitchReservation(reservation)).rejects.toThrow('session.agentSwitchChanged');
    expect(mock.sessions.root.metadata!.conversationSwitch?.targetSessionId).toBe('target');
});

it('releases only its known unsent targetless reservation and keeps an unknown launch pending', async () => {
    const { reserveConversationSwitch, releaseConversationSwitchReservation } = await import('./conversationSwitch');
    const reservation = { rootId: record.rootId, sourceId: record.sourceId, requestId: record.requestId };
    await reserveConversationSwitch(reservation);
    await expect(recoverConversationSwitch('root')).rejects.toThrow('session.agentSwitchPending');
    expect(mock.delivery).not.toHaveBeenCalled();
    await releaseConversationSwitchReservation(reservation);
    expect(mock.sessions.root.metadata!.conversationSwitch).toBeUndefined();
});


it('unlocks a targetless abandoned launch on explicit reload recovery only after daemon cancellation proof', async () => {
    const { reserveConversationSwitch } = await import('./conversationSwitch');
    await reserveConversationSwitch({ rootId: 'root', sourceId: 'root', requestId: record.requestId });
    mock.cancel.mockResolvedValue({ success: true, cancelled: true, targetSessionId: 'orphaned-candidate' });
    await expect(recoverConversationSwitch('root')).resolves.toBe(true);
    expect(mock.cancel).toHaveBeenCalledWith({ machineId: 'm', rootSessionId: 'root', sourceSessionId: 'root', requestId: record.requestId });
    expect(mock.sessions.root.metadata!.conversationSwitch).toBeUndefined();
    expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
    expect(mock.delivery).not.toHaveBeenCalled();
});

it('recovers a bound but never-sent launch only with daemon proof that all target writers stopped', async () => {
    await claimConversationSwitch(record);
    mock.delivery.mockResolvedValue(false);
    mock.cancel.mockResolvedValue({ success: true, cancelled: true, targetSessionId: 'target' });
    await expect(recoverConversationSwitch('root')).resolves.toBe(true);
    expect(mock.sessions.root.metadata!.conversationSwitch).toBeUndefined();
    expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
    expect(mock.sessions.target.metadata!.conversationRootSessionId).toBeUndefined();
});

it('rejects a cancelled handoff request even after its candidate becomes an ordinary independent continuation', async () => {
    await claimConversationSwitch(record);
    await releaseConversationSwitch(record);
    expect(mock.sessions.target.metadata!.conversationRootSessionId).toBeUndefined();
    expect(() => assertConversationSendAllowed('target', record.requestId)).toThrow('session.agentSwitchChanged');
    expect(() => assertConversationSendAllowed('target')).not.toThrow();
});

it.each(['root', 'target'])('does not send or publish a candidate when %s was archived after preparation', async id => {
    await claimConversationSwitch(record);
    mock.sessions[id].metadata!.lifecycleState = 'archived';
    expect(() => assertConversationSendAllowed('target', record.requestId)).toThrow('session.agentSwitchUnavailable');
    await expect(commitConversationSwitch(record)).rejects.toThrow('session.agentSwitchUnavailable');
    expect(mock.sessions.root.metadata!.conversationActiveSessionId).toBeUndefined();
});
