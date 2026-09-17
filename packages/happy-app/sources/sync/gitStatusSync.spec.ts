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
});
