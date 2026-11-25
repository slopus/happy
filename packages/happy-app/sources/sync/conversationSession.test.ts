import { describe, expect, it } from 'vitest';
import { MetadataSchema, type Session } from './storageTypes';
import { getConversationRootSessionId, getConversationSessionChain, hasConversationClaim, isConversationSessionCurrent, projectConversationSessions, resolveConversationRootSessionId, resolveConversationSessionId } from './conversationSession';

function session(id: string, metadata: Partial<NonNullable<Session['metadata']>> = {}, overrides: Partial<Session> = {}): Session {
    return { id, seq: 1, createdAt: 1, updatedAt: 10, active: false, activeAt: 10, presence: 10,
        metadata: { path: '/repo', host: 'test', machineId: 'machine', ...metadata }, metadataVersion: 1,
        agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, ...overrides };
}

describe('logical chat identity', () => {
    it('keeps an explicit new-session continuation independent from its source', () => {
        const root = session('root');
        const separate = session('separate', { continuationOfSessionId: 'root', continuationContext: 'previous task' });
        const sessions = { root, separate };
        expect(getConversationRootSessionId(separate)).toBe('separate');
        expect(resolveConversationSessionId(sessions, 'separate')).toBe('separate');
        expect(projectConversationSessions(sessions)).toEqual([root, separate]);
        expect(projectConversationSessions(sessions)[0]).toBe(root);
    });

    it('follows the authoritative root after several agent switches without reviving an earlier worker', () => {
        const root = session('root', { conversationActiveSessionId: 'third', flavor: 'codex' });
        const second = session('second', { conversationRootSessionId: 'root', continuationOfSessionId: 'root', flavor: 'antigravity' });
        const third = session('third', { conversationRootSessionId: 'root', continuationOfSessionId: 'second', flavor: 'codex' });
        const sessions = { root, second, third };
        for (const id of Object.keys(sessions)) expect(resolveConversationSessionId(sessions, id)).toBe('third');
        expect(isConversationSessionCurrent(sessions, 'root')).toBe(false);
        expect(isConversationSessionCurrent(sessions, 'second')).toBe(false);
        expect(isConversationSessionCurrent(sessions, 'third')).toBe(true);
        expect(projectConversationSessions(sessions)).toMatchObject([{ id: 'root', executionSessionId: 'third', metadata: { flavor: 'codex' } }]);
    });

    it('does not select the source if an active target or root has not loaded', () => {
        const root = session('root', { conversationActiveSessionId: 'missing' });
        const orphan = session('orphan', { conversationRootSessionId: 'unloaded' });
        expect(resolveConversationSessionId({ root, orphan }, 'root')).toBeNull();
        expect(resolveConversationSessionId({ root, orphan }, 'orphan')).toBeNull();
        expect(resolveConversationSessionId({ root, orphan }, 'unknown')).toBeNull();
        expect(isConversationSessionCurrent({ root }, 'root')).toBe(false);
        expect(projectConversationSessions({ root, orphan }).map(row => row.id)).toEqual(['root', 'orphan']);
    });

    it('refuses a target from another chat and preserves both rows', () => {
        const root = session('root', { conversationActiveSessionId: 'other' });
        const other = session('other', { conversationRootSessionId: 'different' });
        expect(resolveConversationSessionId({ root, other }, 'root')).toBeNull();
        expect(projectConversationSessions({ root, other }).map(row => row.id)).toEqual(['root', 'other']);
    });

    it.each([
        { conversationRootSessionId: 'root', path: '/other' },
        { conversationRootSessionId: 'root', machineId: 'other-machine' },
        { conversationRootSessionId: 'root', conversationActiveSessionId: 'root' },
    ])('refuses mismatched execution ownership: %j', metadata => {
        const root = session('root', { conversationActiveSessionId: 'target' });
        const target = session('target', metadata);
        expect(resolveConversationSessionId({ root, target }, 'root')).toBeNull();
    });

    it('rejects cyclic root membership instead of following arbitrary nested pointers', () => {
        const a = session('a', { conversationRootSessionId: 'b' });
        const b = session('b', { conversationRootSessionId: 'a' });
        expect(resolveConversationSessionId({ a, b }, 'a')).toBeNull();
        expect(projectConversationSessions({ a, b }).map(row => row.id)).toEqual(['a', 'b']);
    });

    it('projects live status and recency while retaining the chat title, creation time, and original objects', () => {
        const root = session('root', { conversationActiveSessionId: 'target', summary: { text: 'My chat', updatedAt: 1 }, flavor: 'codex' });
        const target = session('target', { conversationRootSessionId: 'root', summary: { text: 'Generated target title', updatedAt: 20 }, flavor: 'antigravity' },
            { createdAt: 20, active: true, presence: 'online', lastUserMessageAt: 30, draft: 'next', agentState: { turnStatus: { status: 'running', updatedAt: 30 } } });
        const sessions = { root, target };
        const before = JSON.stringify(sessions);
        const rows = projectConversationSessions(sessions);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'root', executionSessionId: 'target', createdAt: 1, active: true, presence: 'online',
            lastUserMessageAt: 30, draft: 'next', metadata: { summary: { text: 'My chat' }, flavor: 'antigravity' }, agentState: { turnStatus: { status: 'running' } } });
        expect(rows[0].conversationSessionIds).toEqual(['root', 'target']);
        expect(JSON.stringify(sessions)).toBe(before);
        expect(rows[0]).not.toBe(root);
        expect(rows[0]).not.toBe(target);
    });

    it('can read a pending target membership before the root pointer commits without duplicating the root row', () => {
        const root = session('root', { conversationSwitch: { id: 'switch', sourceSessionId: 'root', targetSessionId: 'target' } });
        const target = session('target', { conversationRootSessionId: 'root' });
        expect(resolveConversationSessionId({ root, target }, 'target')).toBe('root');
        expect(projectConversationSessions({ root, target })).toMatchObject([{ id: 'root', executionSessionId: 'root' }]);
    });

    it('preserves the logical identity contract through encrypted metadata schema parsing', () => {
        expect(MetadataSchema.parse({ path: '/repo', host: 'test', conversationRootSessionId: 'root', conversationActiveSessionId: 'target',
            conversationSwitch: { id: 'switch', sourceSessionId: 'source', targetSessionId: 'target' },
            conversationDeletePlan: { sessionIds: ['source', 'target', 'root'], completedSessionIds: ['source'], activeSessionId: 'target' },
        })).toMatchObject({
            conversationRootSessionId: 'root', conversationActiveSessionId: 'target', conversationSwitch: { id: 'switch', sourceSessionId: 'source', targetSessionId: 'target' },
            conversationDeletePlan: { sessionIds: ['source', 'target', 'root'], completedSessionIds: ['source'], activeSessionId: 'target' },
        });
    });

    it('infers stripped current and historical membership only from the complete committed chain', () => {
        const root = session('root', { conversationActiveSessionId: 'current', summary: { text: 'Shared', updatedAt: 1 } });
        const history = session('history', { continuationOfSessionId: 'root' });
        const current = session('current', { continuationOfSessionId: 'history', flavor: 'antigravity' });
        const sessions = { root, history, current };
        const before = JSON.stringify(sessions);
        for (const id of Object.keys(sessions)) {
            expect(resolveConversationRootSessionId(sessions, id)).toBe('root');
            expect(resolveConversationSessionId(sessions, id)).toBe('current');
            expect(getConversationSessionChain(sessions, id)).toEqual(['current', 'history', 'root']);
        }
        expect(projectConversationSessions(sessions)).toMatchObject([{ id: 'root', executionSessionId: 'current',
            conversationSessionIds: ['root', 'history', 'current'], metadata: { summary: { text: 'Shared' } } }]);
        expect(JSON.stringify(sessions)).toBe(before);
    });

    it('keeps a separate continuation independent beside a committed chat even when its source belongs to that chat', () => {
        const root = session('root', { conversationActiveSessionId: 'current' });
        const current = session('current', { continuationOfSessionId: 'root' });
        const separate = session('separate', { continuationOfSessionId: 'current' });
        const sessions = { root, current, separate };
        expect(resolveConversationRootSessionId(sessions, 'separate')).toBe('separate');
        expect(resolveConversationSessionId(sessions, 'separate')).toBe('separate');
        expect(getConversationSessionChain(sessions, 'separate')).toEqual(['separate']);
        expect(projectConversationSessions(sessions).map(row => row.id)).toEqual(['root', 'separate']);
    });

    it('does not infer membership from continuation ancestry without a committed root claim', () => {
        const root = session('root', { continuationOfSessionId: 'deleted-parent' });
        const separate = session('separate', { continuationOfSessionId: 'root' });
        expect(resolveConversationRootSessionId({ root, separate }, 'root')).toBe('root');
        expect(resolveConversationRootSessionId({ root, separate }, 'separate')).toBe('separate');
        expect(projectConversationSessions({ root, separate })).toEqual([root, separate]);
    });

    it.each(['missing-middle', 'missing-predecessor', 'cycle', 'wrong-path', 'wrong-machine', 'unknown-machine', 'foreign-hint', 'nested-active'] as const)(
        'refuses stripped ownership recovery when a chain has %s', kind => {
            const root = session('root', { conversationActiveSessionId: 'current' });
            const history = session('history', { continuationOfSessionId: 'root' });
            const current = session('current', { continuationOfSessionId: 'history' });
            const sessions: Record<string, Session> = { root, history, current, foreign: session('foreign') };
            if (kind === 'missing-middle') delete sessions.history;
            if (kind === 'missing-predecessor') delete history.metadata!.continuationOfSessionId;
            if (kind === 'cycle') history.metadata!.continuationOfSessionId = 'current';
            if (kind === 'wrong-path') history.metadata!.path = '/elsewhere';
            if (kind === 'wrong-machine') history.metadata!.machineId = 'another-machine';
            if (kind === 'unknown-machine') { delete root.metadata!.machineId; delete history.metadata!.machineId; delete current.metadata!.machineId; }
            if (kind === 'foreign-hint') history.metadata!.conversationRootSessionId = 'foreign';
            if (kind === 'nested-active') history.metadata!.conversationActiveSessionId = 'history';
            expect(resolveConversationRootSessionId(sessions, 'root')).toBeNull();
            expect(resolveConversationRootSessionId(sessions, 'current')).toBeNull();
            expect(resolveConversationSessionId(sessions, 'root')).toBeNull();
            expect(getConversationSessionChain(sessions, 'root')).toBeNull();
            expect(projectConversationSessions(sessions).some(row => row.executionSessionId === 'current')).toBe(false);
        },
    );

    it('rejects two authoritative roots claiming the same target instead of picking a matching path', () => {
        const root = session('root', { conversationActiveSessionId: 'current' });
        const other = session('other', { conversationActiveSessionId: 'current' });
        const current = session('current', { continuationOfSessionId: 'root' });
        const sessions = { root, other, current };
        for (const id of Object.keys(sessions)) expect(resolveConversationRootSessionId(sessions, id)).toBeNull();
        expect(projectConversationSessions(sessions)).toEqual([root, other, current]);
    });

    it('refuses an explicit foreign hint even if that unrelated root exists', () => {
        const root = session('root', { conversationActiveSessionId: 'current' });
        const foreign = session('foreign');
        const current = session('current', { continuationOfSessionId: 'root', conversationRootSessionId: 'foreign' });
        expect(resolveConversationRootSessionId({ root, foreign, current }, 'current')).toBeNull();
        expect(resolveConversationRootSessionId({ root, foreign, current }, 'root')).toBeNull();
        expect(resolveConversationRootSessionId({ root, foreign, current }, 'foreign')).toBe('foreign');
    });

    it('resolves an explicitly linked reservation candidate before it belongs to the committed chain', () => {
        const root = session('root', { conversationSwitch: { id: 'switch', sourceSessionId: 'root', targetSessionId: 'candidate' } });
        const candidate = session('candidate', { conversationRootSessionId: 'root', continuationOfSessionId: 'root' });
        expect(resolveConversationRootSessionId({ root, candidate }, 'candidate')).toBe('root');
        expect(getConversationSessionChain({ root, candidate }, 'candidate')).toEqual(['root']);
    });

    it('enumerates an ordinary large session map once during projection', () => {
        const values = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => {
            const id = `ordinary-${index}`;
            return [id, session(id, { continuationOfSessionId: 'unloaded-independent-source' })];
        }));
        let enumerations = 0;
        const sessions = new Proxy(values, { ownKeys: target => { enumerations++; return Reflect.ownKeys(target); } });
        expect(projectConversationSessions(sessions)).toHaveLength(2000);
        expect(enumerations).toBe(1);
    });

    it('retains an unresolved historical claim when its stripped predecessor chain is malformed', () => {
        const root = session('root', { conversationActiveSessionId: 'current' });
        const current = session('current', { conversationRootSessionId: 'root', continuationOfSessionId: 'history' });
        const history = session('history', { continuationOfSessionId: 'missing' });
        const separate = session('separate', { continuationOfSessionId: 'history' });
        const sessions = { root, current, history, separate };
        expect(resolveConversationRootSessionId(sessions, 'history')).toBeNull();
        expect(hasConversationClaim(sessions, 'history')).toBe(true);
        expect(hasConversationClaim(sessions, 'missing')).toBe(true);
        expect(hasConversationClaim(sessions, 'separate')).toBe(false);
        expect(resolveConversationRootSessionId(sessions, 'separate')).toBe('separate');
    });

    it('reports explicit, reserved, and persisted deletion claims without authorizing a worker', () => {
        const root = session('root', { conversationSwitch: { id: 'switch', sourceSessionId: 'root', targetSessionId: 'candidate' } });
        const candidate = session('candidate', { continuationOfSessionId: 'root' });
        const member = session('member', { conversationRootSessionId: 'unloaded' });
        const deleting = session('deleting', { conversationDeletePlan: {
            sessionIds: ['gone', 'deleting'], completedSessionIds: ['gone'], activeSessionId: 'gone',
        } });
        const sessions = { root, candidate, member, deleting };
        for (const id of ['root', 'candidate', 'member', 'deleting', 'gone']) expect(hasConversationClaim(sessions, id)).toBe(true);
        expect(hasConversationClaim(sessions, 'unrelated')).toBe(false);
        expect(resolveConversationRootSessionId(sessions, 'member')).toBeNull();
    });
});
