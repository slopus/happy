import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ sessions: {} as Record<string, any>, deleted: new Set<string>(), hydrate: vi.fn() }));
vi.mock('@/sync/storage', () => ({ storage: Object.assign((select: any) => select({ sessions: mock.sessions }), { getState: () => ({ sessions: mock.sessions }) }) }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionHydrated: mock.hydrate } }));
vi.mock('@/sync/projectSessionLinks', () => ({ isProjectSessionDeleted: (id: string) => mock.deleted.has(id) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { useProjectConversation } from './useProjectConversation';
let renderer: any, state: ReturnType<typeof useProjectConversation>;
function Host({ id, known = false }: { id?: string; known?: boolean }) { state = useProjectConversation(id, known, metadata => metadata.machineId === 'machine' && metadata.goalBoard?.taskId === 'task'); return null; }
function render(id?: string, known = false) { act(() => { if (renderer) renderer.update(<Host id={id} known={known} />); else renderer = TestRenderer.create(<Host id={id} known={known} />); }); }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mock.sessions = {}; mock.deleted.clear(); mock.hydrate.mockReset().mockResolvedValue(false); });
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });
it('trusted history enters the regular chat loader before its header is hydrated', () => { render('history', true); expect(state.verified).toBe(true); expect(mock.hydrate).not.toHaveBeenCalled(); });
it.each([{ machineId: 'other', goalBoard: { taskId: 'task' } }, { machineId: 'machine', goalBoard: { taskId: 'sibling' } }])('live ownership overrides an old trusted history link: %o', metadata => { mock.sessions.history = { metadata }; render('history', true); expect(state.verified).toBe(false); expect(state.rejected).toBe(true); });
it('a deleted history link stays rejected', () => { mock.deleted.add('history'); render('history', true); expect(state.rejected).toBe(true); expect(state.verified).toBe(false); });
it('unknown URL hydration failure is retryable and success removes the error', async () => {
    await act(async () => { render('url'); });
    expect(state.error).toBe('projectGoals.sessionUnavailable');
    mock.hydrate.mockImplementation(async (id: string) => { mock.sessions[id] = { metadata: { machineId: 'machine', goalBoard: { taskId: 'task' } } }; return true; });
    await act(async () => { state.retry(); });
    render('url');
    expect(state.verified).toBe(true); expect(state.error).toBeNull();
});
it('switching to trusted history clears a previous failed URL without a second hydration', async () => { await act(async () => { render('bad'); }); render('good', true); expect(state.error).toBeNull(); expect(state.verified).toBe(true); expect(mock.hydrate).toHaveBeenCalledTimes(1); });
it('a late old request cannot replace the selected conversation state', async () => {
    let reject!: (error: Error) => void; mock.hydrate.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render('old'); render('new', true); await act(async () => reject(new Error('old failure')));
    expect(state.verified).toBe(true); expect(state.error).toBeNull();
});
it('missing metadata after a successful response does not spin indefinitely on an unknown URL', async () => { mock.hydrate.mockResolvedValue(true); await act(async () => { render('bad-header'); }); expect(state.error).toBe('projectGoals.sessionUnavailable'); });
