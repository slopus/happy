import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no local declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { useConversationSessions } from './useConversationSessions';
import { useSessionSearch } from './useSessionSearch';

const mocks = vi.hoisted(() => ({ sessions: [] as Session[] }));
vi.mock('@/sync/storage', () => ({ useAllSessions: () => mocks.sessions, useAllMachines: () => [] }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (session: Session) => session.metadata?.summary?.text ?? 'New chat', getSessionSubtitle: (session: Session) => session.metadata?.path ?? '' }));
let result: ReturnType<typeof useConversationSessions>;
let search: ReturnType<typeof useSessionSearch>;
function Probe({ query = '' }: { query?: string }) { result = useConversationSessions(); search = useSessionSearch(query); return null; }
function session(id: string, metadata: Partial<NonNullable<Session['metadata']>>): Session {
    return { id, createdAt: 1, updatedAt: 10, activeAt: 10, seq: 1, active: false, presence: 10, thinking: false, thinkingAt: 0,
        metadata: { path: '/repo', host: 'test', ...metadata }, metadataVersion: 1, agentState: null, agentStateVersion: 0 };
}
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; mocks.sessions = []; });

describe('conversation display consumers', () => {
    it('returns and searches one canonical chat while keeping a separately requested continuation visible', () => {
        mocks.sessions = [
            session('root', { conversationActiveSessionId: 'current', summary: { text: 'Shared task', updatedAt: 1 } }),
            session('current', { conversationRootSessionId: 'root', continuationOfSessionId: 'root', flavor: 'antigravity', summary: { text: 'Worker generated name', updatedAt: 10 } }),
            session('separate', { continuationOfSessionId: 'root', summary: { text: 'Shared task branch', updatedAt: 10 } }),
        ];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe query="shared" />); });
        expect(result.map(row => row.id)).toEqual(['root', 'separate']);
        expect(result[0]).toMatchObject({ executionSessionId: 'current', metadata: { flavor: 'antigravity' } });
        expect(search.map(row => row.session.id)).toEqual(['root', 'separate']);
        expect(search.map(row => row.title)).toEqual(['Shared task', 'Shared task branch']);
        const prior = result;
        act(() => renderer.update(<Probe query="Worker generated name" />));
        expect(result).toBe(prior);
        expect(search).toEqual([]);
        act(() => renderer.unmount());
    });
});
