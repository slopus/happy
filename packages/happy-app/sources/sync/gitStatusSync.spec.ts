import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: { sessions: {} as Record<string, any> },
    sessionBash: vi.fn(),
    applyGitStatus: vi.fn(),
}));
vi.mock('./ops', () => ({ sessionBash: mocks.sessionBash }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ ...mocks.state, applyGitStatus: mocks.applyGitStatus }) } }));

import { GitStatusSync } from './gitStatusSync';

function session(id: string, active: boolean) {
    return { id, active, metadata: { machineId: 'm', path: '/repo' } };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.sessions = { a: session('a', true), b: session('b', true) };
    mocks.sessionBash.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' });
});

describe('git status sync', () => {
    it('runs git through a live session of the project, not the one that created the sync', async () => {
        const gitStatus = new GitStatusSync();
        const sync = gitStatus.getSync('a');
        gitStatus.getSync('b');
        mocks.state.sessions.a = session('a', false);
        await sync.invalidateAndAwait();
        expect(mocks.sessionBash).toHaveBeenCalled();
        for (const call of mocks.sessionBash.mock.calls) expect(call[0]).toBe('b');
        expect(mocks.applyGitStatus).toHaveBeenCalledOnce();

        mocks.state.sessions.b = session('b', false);
        mocks.sessionBash.mockClear();
        await sync.invalidateAndAwait();
        expect(mocks.sessionBash).not.toHaveBeenCalled();
    });

    it('refreshes a viewed project when a never-opened sibling session mutates it', async () => {
        vi.useFakeTimers();
        try {
            const gitStatus = new GitStatusSync();
            const sync = gitStatus.getSync('a');
            const spy = vi.spyOn(sync, 'invalidate');
            // b streams a tool result without ever having been opened.
            gitStatus.invalidate('b');
            await vi.advanceTimersByTimeAsync(300);
            expect(spy).toHaveBeenCalledOnce();

            // A session of a project nobody views creates nothing.
            mocks.state.sessions.c = { id: 'c', active: true, metadata: { machineId: 'm', path: '/other' } };
            gitStatus.invalidate('c');
            await vi.advanceTimersByTimeAsync(300);
            expect(spy).toHaveBeenCalledOnce();
            expect(mocks.applyGitStatus).not.toHaveBeenCalledWith('m:/other', expect.anything());
        } finally {
            vi.useRealTimers();
        }
    });
});
