import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all external dependencies before importing the module under test.
vi.mock('./ops', () => ({
    sessionBash: vi.fn(),
}));

vi.mock('./storage', () => ({
    getSession: vi.fn(),
    storage: {
        getState: vi.fn(() => ({
            sessions: {},
            sharedSessions: {},
            applyGitStatus: vi.fn(),
        })),
    },
}));

vi.mock('./projectManager', () => ({
    projectManager: { updateProjectGitStatus: vi.fn() },
    createProjectKey: (machineId: string, path: string) => `${machineId}:${path}`,
}));

vi.mock('@/utils/workspaceRepos', () => ({
    getWorkspaceRepos: () => [],
}));

vi.mock('./gitStatusRefreshPolicy', () => ({
    decideNotGitRefreshOutcome: () => ({ action: 'clear', nextConsecutiveNotGitDetections: 1 }),
}));

vi.mock('./gitStatusSessionSelection', () => ({
    selectPreferredGitStatusSession: (candidates: Array<{ sessionId: string; session: unknown }>) =>
        candidates[0] ?? null,
}));

import { GitStatusSync } from './gitStatusSync';
import { getSession, storage } from './storage';
import { sessionBash } from './ops';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MACHINE = 'machine-1';
const PROJECT_PATH = '/repo';
const PROJECT_KEY = `${MACHINE}:${PROJECT_PATH}`;

/** Delimiter used by the combined git command (must match the class constant). */
const DELIM = '__GIT_SECT_d4e8f2a1b7c3__';

function makeSession(machineId = MACHINE, path = PROJECT_PATH) {
    return {
        metadata: { machineId, path },
        active: true,
    };
}

/** Build a successful combined-command stdout that `fetchGitStatusForProject` expects. */
function makeGitOutput() {
    const revParse = 'true';
    const status = '# branch.oid abc123\n# branch.head main';
    const diff = '';
    const cachedDiff = '';
    return [revParse, status, diff, cachedDiff].join(DELIM);
}

function mockSessionFound(sessionId: string) {
    const session = makeSession();
    vi.mocked(getSession).mockImplementation((id) => (id === sessionId ? session as any : null));
    vi.mocked(storage.getState).mockReturnValue({
        sessions: { [sessionId]: session },
        sharedSessions: {},
        applyGitStatus: vi.fn(),
    } as any);
}

function mockSessionBashSuccess() {
    vi.mocked(sessionBash).mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: makeGitOutput(),
        stderr: '',
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitStatusSync', () => {
    let sync: GitStatusSync;

    beforeEach(() => {
        vi.useFakeTimers();
        sync = new GitStatusSync();
        vi.mocked(getSession).mockReset();
        vi.mocked(sessionBash).mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // Trailing-edge debounce
    // -----------------------------------------------------------------------

    describe('trailing-edge debounce', () => {
        it('coalesces rapid invalidations into one deferred fetch', async () => {
            const sid = 'session-1';
            mockSessionFound(sid);
            mockSessionBashSuccess();

            // First invalidation triggers immediate fetch.
            sync.invalidate(sid);
            await vi.advanceTimersByTimeAsync(0);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Multiple invalidations within cooldown should schedule only one deferred timer.
            sync.invalidate(sid);
            sync.invalidate(sid);
            sync.invalidate(sid);
            // No new fetch yet — still in cooldown.
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // After cooldown expires, the deferred invalidation fires exactly once.
            await vi.advanceTimersByTimeAsync(3_100);
            expect(sessionBash).toHaveBeenCalledTimes(2);
        });

        it('fires the deferred fetch after cooldown expires', async () => {
            const sid = 'session-1';
            mockSessionFound(sid);
            mockSessionBashSuccess();

            // Trigger + complete the first fetch.
            sync.invalidate(sid);
            await vi.advanceTimersByTimeAsync(0);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Invalidate during cooldown → deferred.
            sync.invalidate(sid);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Advance past cooldown.
            await vi.advanceTimersByTimeAsync(3_100);
            expect(sessionBash).toHaveBeenCalledTimes(2);
        });
    });

    // -----------------------------------------------------------------------
    // Retry backoff
    // -----------------------------------------------------------------------

    describe('scheduleRetry', () => {
        it('preserves backoff counter across retries', async () => {
            const sid = 'session-1';
            mockSessionFound(sid);

            // Make every fetch fail so scheduleRetry fires.
            vi.mocked(sessionBash).mockResolvedValue({
                success: false,
                exitCode: 1,
                stdout: '',
                stderr: 'connection reset',
            });

            sync.invalidate(sid);
            await vi.advanceTimersByTimeAsync(0);

            // 1st retry: 2.5s backoff
            await vi.advanceTimersByTimeAsync(2_600);
            expect(sessionBash).toHaveBeenCalledTimes(2);

            // 2nd retry: 5s backoff (exponential, not reset to 2.5s)
            await vi.advanceTimersByTimeAsync(2_600);
            expect(sessionBash).toHaveBeenCalledTimes(2); // not yet
            await vi.advanceTimersByTimeAsync(2_600);
            expect(sessionBash).toHaveBeenCalledTimes(3);
        });
    });

    // -----------------------------------------------------------------------
    // stop() with multiple sessions
    // -----------------------------------------------------------------------

    describe('stop()', () => {
        it('does not drop deferred invalidation when other sessions remain', async () => {
            const sid1 = 'session-1';
            const sid2 = 'session-2';

            // Both sessions belong to the same project.
            const session = makeSession();
            vi.mocked(getSession).mockImplementation((id) =>
                (id === sid1 || id === sid2) ? session as any : null
            );
            vi.mocked(storage.getState).mockReturnValue({
                sessions: { [sid1]: session, [sid2]: session },
                sharedSessions: {},
                applyGitStatus: vi.fn(),
            } as any);
            mockSessionBashSuccess();

            // Register both sessions and trigger an initial fetch.
            sync.getSync(sid1);
            sync.getSync(sid2);
            sync.invalidate(sid1);
            await vi.advanceTimersByTimeAsync(0);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Schedule a deferred invalidation (within cooldown).
            sync.invalidate(sid2);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Stop one session — deferred timer must survive.
            sync.stop(sid1);

            // After cooldown, the deferred fetch should still fire.
            await vi.advanceTimersByTimeAsync(3_100);
            expect(sessionBash).toHaveBeenCalledTimes(2);
        });

        it('clears deferred invalidation when the last session is removed', async () => {
            const sid = 'session-1';
            mockSessionFound(sid);
            mockSessionBashSuccess();

            // Initial fetch.
            sync.invalidate(sid);
            await vi.advanceTimersByTimeAsync(0);
            expect(sessionBash).toHaveBeenCalledTimes(1);

            // Schedule a deferred invalidation.
            sync.invalidate(sid);

            // Stop the only session — deferred timer should be cleared.
            sync.stop(sid);

            // After cooldown, no fetch should fire.
            await vi.advanceTimersByTimeAsync(3_100);
            expect(sessionBash).toHaveBeenCalledTimes(1);
        });
    });
});
