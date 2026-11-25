import { describe, expect, it } from 'vitest';
import { MetadataSchema, type Session } from './storageTypes';
import { getConversationRootSessionId, isConversationSessionCurrent, projectConversationSessions, resolveConversationSessionId } from './conversationSession';

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
});
