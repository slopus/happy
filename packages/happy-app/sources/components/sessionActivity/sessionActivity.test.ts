import { describe, expect, it, vi } from 'vitest';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import type { Session } from '@/sync/storageTypes';
import { buildSessionActivity, countSessionActivity, matchesActivityScope } from './sessionActivity';
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
function session(id: string, options: Partial<Session> = {}): Session {
    return { id, updatedAt: 100, presence: 'online', thinking: false, metadata: { machineId: 'm1', path: '/work/project/task' }, agentState: {}, ...options } as Session;
}
const pending = { requests: { question: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } } as Session['agentState'];
describe('real session activity', () => {
    it('counts mutually exclusive permission, failure, running and unread outcomes, not task acceptance', () => {
        const rows = buildSessionActivity([
            session('question', { thinking: true, agentState: pending }),
            session('failed', { agentState: { turnStatus: { status: 'failed', updatedAt: 1 } } }),
            session('running', { thinking: true }),
            session('queued', { agentState: { queuedMessages: 1 } }),
            session('done', { agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } }),
            session('legacy'), session('idle'),
        ], new Set(['question', 'running', 'done', 'legacy']), true);
        expect(countSessionActivity(rows)).toEqual({ attention: 2, running: 2, unread: 2, unknown: 0 });
        expect(rows.find(row => row.session.id === 'question')?.category).toBe('attention');
        expect(rows.some(row => row.session.id === 'idle')).toBe(false);
    });
    it('does not advertise disconnected work as running, including a stale online header after socket loss', () => {
        const sessions = [session('offline', { presence: 1, agentState: { turnStatus: { status: 'running', updatedAt: 1 } } }), session('stale', { thinking: true })];
        expect(countSessionActivity(buildSessionActivity(sessions, new Set(), false))).toEqual({ attention: 0, running: 0, unread: 0, unknown: 2 });
        expect(countSessionActivity(buildSessionActivity(sessions, new Set(), true))).toEqual({ attention: 0, running: 1, unread: 0, unknown: 1 });
    });
    it('excludes explicit archives and retired workers, deduplicates IDs, but keeps unread auto-archived results', () => {
        const application = session('app-result', { metadata: { path: '/work', application: { appId: 'test', bindingId: 'binding' } } as any, agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } });
        expect(isSessionArchived(application)).toBe(true);
        const rows = buildSessionActivity([
            session('archived', { thinking: true, metadata: { path: '/work', lifecycleState: 'archived' } as any }),
            session('retired', { thinking: true, metadata: { path: '/work', flavor: 'personal' } as any }),
            session('dup', { thinking: true }), session('dup', { thinking: true }),
            application,
        ], new Set(['archived', 'app-result']), true);
        expect(rows.map(row => row.session.id).sort()).toEqual(['app-result', 'dup']);
    });
    it('uses machine + explicit binding first, and bounded legacy paths second', () => {
        const scope = { machineId: 'm1', path: '/work/project', title: 'Project' };
        const match = (s: Session) => matchesActivityScope({ session: s } as any, scope);
        expect(match(session('legacy'))).toBe(true);
        expect(match(session('prefix', { metadata: { machineId: 'm1', path: '/work/project-other' } as any }))).toBe(false);
        expect(match(session('other-machine', { metadata: { machineId: 'm2', path: '/work/project' } as any }))).toBe(false);
        expect(match(session('bound-elsewhere', { metadata: { machineId: 'm1', path: '/work/project', goalBoard: { featurePath: '/elsewhere', taskId: 't1' } } as any }))).toBe(false);
        const bound = session('bound', { metadata: { machineId: 'm1', path: '/elsewhere', goalBoard: { featurePath: '/work/project', taskId: 't1' } } as any });
        expect(match(bound)).toBe(true);
        expect(matchesActivityScope({ session: bound } as any, { ...scope, taskId: 't2', directory: '/elsewhere' })).toBe(false);
        expect(matchesActivityScope({ session: bound } as any, { ...scope, taskId: 't1' })).toBe(true);
        expect(matchesActivityScope({ session: session('legacy') } as any, { ...scope, taskId: 't1', directory: '/work/project/task' })).toBe(true);
    });
});
