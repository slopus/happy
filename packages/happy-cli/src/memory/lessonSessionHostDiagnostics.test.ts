import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    debug: vi.fn(), key: vi.fn(), verifier: vi.fn(), verify: vi.fn(), snapshot: vi.fn(),
    close: vi.fn(), open: vi.fn(), user: vi.fn(), turn: vi.fn(),
    host: vi.fn(), issuer: vi.fn(),
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }));
vi.mock('./lessonHostRuntime', () => ({ fetchLessonGrantPublicKey: mocks.key, requestLessonSnapshotGrant: mocks.snapshot }));
vi.mock('./lessonGrantVerifier', () => ({ createLessonGrantVerifier: mocks.verifier, lessonGrantAudience: () => 'audience' }));
vi.mock('./lessonHostSupervisor', () => ({ createLessonHostSupervisor: (options: any) => ({
    ensureOpen: async () => {
        if (!await options.requestSnapshotGrant('private-project')) return null;
        const verified = options.routeVerifier().verify({ envelope: 'private-envelope', request: {} });
        if (!verified.ok || verified.claims.projectId !== 'private-project') return null;
        return mocks.open();
    },
    close: mocks.close, openedUserId: mocks.user, authorize: async () => 'private-user',
}) }));
vi.mock('./lessonTurnHost', () => ({ createLessonTurnHost: mocks.turn }));
vi.mock('./lessonReviewWorker', () => ({ createLessonReviewWorker: () => ({}), lessonCandidateEnvelope: vi.fn() }));
vi.mock('./lessonSettingsStore', () => ({
    createLessonSettingsStore: () => ({}), createLessonReviewOutcomeStore: () => ({}),
    lessonReviewLedgerPath: () => '/unused', lessonReviewOutcomePath: () => '/unused', lessonSettingsPath: () => '/unused',
}));
vi.mock('./lessonReviewBudget', () => ({ LessonReviewBudget: class {} }));
vi.mock('@/aplus/refreshMcpCallerGrant', () => ({ refreshMcpCallerGrantIfExpiring: async () => {} }));

import { createLazyLessonSessionHost, createLessonSessionHost } from './lessonSessionHost';

const input = () => ({
    accountToken: 'private-token', machineId: 'private-machine', sessionId: 'private-session', happyHomeDir: '/private/home',
    env: {
        HAPPY_APLUS_MCP_CONFIG_URL: 'https://private.example/api/me/mcp-config',
        HAPPY_CHECKPOINT_SPAWN_CONTEXT: JSON.stringify({ schemaVersion: 1, projectId: 'private-project', worktreeId: null, checkpointRoot: '/private/checkpoint' }),
        HAPPY_LESSON_DAEMON_HOME: '/private/daemon', CLAUDE_MEMORY_LESSON_OWNER: 'host',
        HAPPY_APLUS_MCP_CALLER_GRANT: 'private-grant',
    } as NodeJS.ProcessEnv,
});
const logs = () => JSON.stringify(mocks.debug.mock.calls);
function expectReason(reason: string) {
    expect(logs()).toContain(reason);
    expect(logs()).not.toContain('private-');
    expect(logs()).not.toContain('/private');
    expect(logs()).not.toContain('private.example');
    expect(logs()).not.toContain('no_match');
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.key.mockResolvedValue('private-key'); mocks.verifier.mockReturnValue({ verify: mocks.verify });
    mocks.verify.mockReturnValue({ ok: true, claims: { projectId: 'private-project' } });
    mocks.snapshot.mockResolvedValue('private-envelope');
    mocks.open.mockResolvedValue({ host: mocks.host, issuer: mocks.issuer });
    mocks.host.mockReturnValue({}); mocks.issuer.mockReturnValue({});
    mocks.user.mockReturnValue('private-user'); mocks.close.mockResolvedValue(undefined);
    mocks.turn.mockReturnValue({});
});

describe('lesson host safe diagnostics', () => {
    it.each([
        ['missing_account', (i: ReturnType<typeof input>) => { i.accountToken = ''; }],
        ['missing_machine', (i: ReturnType<typeof input>) => { i.machineId = ''; }],
        ['missing_origin', (i: ReturnType<typeof input>) => { delete i.env.HAPPY_APLUS_MCP_CONFIG_URL; }],
        ['missing_project', (i: ReturnType<typeof input>) => { delete i.env.HAPPY_CHECKPOINT_SPAWN_CONTEXT; }],
        ['missing_state_root', (i: ReturnType<typeof input>) => { delete i.env.HAPPY_LESSON_DAEMON_HOME; }],
        ['owner_not_host', (i: ReturnType<typeof input>) => { delete i.env.CLAUDE_MEMORY_LESSON_OWNER; }],
    ] as const)('distinguishes %s without network or secrets', async (reason, change) => {
        const args = input(); change(args);
        expect(await createLessonSessionHost(args)).toBeNull();
        expect(mocks.key).not.toHaveBeenCalled(); expectReason(reason);
    });
    it.each([
        ['public_key_unavailable', () => mocks.key.mockResolvedValue(null)],
        ['invalid_public_key', () => mocks.verifier.mockImplementation(() => { throw new Error('private-key'); })],
        ['snapshot_grant_unavailable', () => mocks.snapshot.mockResolvedValue(null)],
        ['grant_rejected', () => mocks.verify.mockReturnValue({ ok: false, reason: 'private-rejection' })],
        ['grant_rejected', () => mocks.verify.mockReturnValue({ ok: true, claims: { projectId: 'private-other' } })],
        ['runtime_unavailable', () => mocks.open.mockResolvedValue(null)],
        ['runtime_unavailable', () => mocks.open.mockRejectedValue(new Error('private-token'))],
        ['runtime_incomplete', () => mocks.host.mockReturnValue(null)],
        ['caller_unavailable', () => mocks.user.mockReturnValue(null)],
    ] as const)('distinguishes %s from an empty recall', async (reason, setup) => {
        setup(); expect(await createLessonSessionHost(input())).toBeNull(); expectReason(reason);
        if (!['public_key_unavailable', 'invalid_public_key'].includes(reason)) expect(mocks.close).toHaveBeenCalledOnce();
    });
    it('records the process cohort and separate recall/ACK evidence, never reads or application', async () => {
        const host = await createLessonSessionHost(input());
        expect(host).not.toBeNull();
        expectReason('ready');
        expect(logs()).toContain('cliVersion'); expect(logs()).toContain('processStartedAt');
        const options = mocks.turn.mock.calls[0][0];
        options.onOutcome('selected'); options.onOutcome('delivered');
        expect(logs()).toContain('phase=recall outcome=selected');
        expect(logs()).toContain('phase=ack outcome=delivered');
        expect(logs()).not.toMatch(/phase=(?:read|applied)/);
        await host!.close(); expect(mocks.close).toHaveBeenCalledOnce();
    });
    it('reports timeout and closes a late successful bootstrap', async () => {
        let land!: (value: unknown) => void;
        mocks.open.mockImplementation(() => new Promise(resolve => { land = resolve; }));
        expect(await createLessonSessionHost({ ...input(), budgetMs: 10 })).toBeNull();
        expectReason('timeout');
        land({ host: mocks.host, issuer: mocks.issuer });
        await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
        expectReason('late_closed');
    });
});


describe('production lazy host diagnostics', () => {
    it('distinguishes a refused snapshot from no_match and recovers on a later turn', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        mocks.snapshot.mockResolvedValueOnce(null);
        mocks.turn.mockImplementation(options => ({
            async recall() { options.onOutcome('no_match'); return { outcome: 'no_match' }; },
        }));
        const host = createLazyLessonSessionHost(input());
        try {
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'unsupported' });
            expectReason('snapshot_grant_unavailable');
            expect(mocks.snapshot).toHaveBeenCalledTimes(1);
            clock.mockReturnValue(6_001);
            // Later turns never spend another readiness budget. Observe the
            // in-flight timeout, then the ready host on the following call.
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'timeout' });
            await vi.waitFor(() => expect(logs()).toContain('outcome=ready'));
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'no_match' });
            expect(logs()).toContain('phase=recall outcome=no_match');
            expect(mocks.snapshot).toHaveBeenCalledTimes(2);
            expect(logs()).not.toContain('private-');
        } finally {
            clock.mockRestore();
            await host.close();
        }
        expect(mocks.close).toHaveBeenCalledTimes(2);
    });
    it('retries on the first turn when the eager bootstrap was refused before the session was bound', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        // Spawn-time refusal: the studio does not know the session's project yet.
        mocks.snapshot.mockResolvedValueOnce(null);
        mocks.turn.mockImplementation(options => ({
            async recall() { options.onOutcome('no_match'); return { outcome: 'no_match' }; },
        }));
        const host = createLazyLessonSessionHost(input());
        try {
            await vi.waitFor(() => expectReason('snapshot_grant_unavailable'));
            // The first message arrives ~2s later, inside the old 5s backoff.
            clock.mockReturnValue(3_000);
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'no_match' });
            expect(mocks.snapshot).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
            await host.close();
        }
    });
    it('keeps the backoff after a refusal that a turn itself waited for', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        mocks.snapshot.mockResolvedValue(null);
        const host = createLazyLessonSessionHost(input());
        try {
            await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
            clock.mockReturnValue(3_000);
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'unsupported' });
            expect(mocks.snapshot).toHaveBeenCalledTimes(2);
            clock.mockReturnValue(4_000);
            await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' });
            expect(mocks.snapshot).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
            await host.close();
        }
    });
    it('reports a thrown bootstrap without leaking the error or disabling the session permanently', async () => {
        mocks.key.mockRejectedValueOnce(new Error('private-token private-query'));
        const host = createLazyLessonSessionHost(input());
        try {
            expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
                .toEqual({ outcome: 'unsupported' });
            expectReason('exception');
        } finally {
            await host.close();
        }
    });
});


it('includes the cohort on production readiness timeout and disposes a late host', async () => {
    let land!: (value: string) => void;
    mocks.key.mockImplementation(() => new Promise(resolve => { land = resolve; }));
    const host = createLazyLessonSessionHost({ ...input(), budgetMs: 5 });
    expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
        .toEqual({ outcome: 'timeout' });
    const diagnostic = mocks.debug.mock.calls.find(args => args[0] === '[lesson-host] phase=readiness outcome=timeout');
    expect(diagnostic?.[1]).toEqual({ cliVersion: expect.any(String), processStartedAt: expect.any(String) });
    await host.close();
    land('private-key');
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expectReason('late_closed');
});

it('does not report ready if host construction throws and releases the supervisor', async () => {
    mocks.turn.mockImplementation(() => { throw new Error('private-failure'); });
    const host = createLazyLessonSessionHost(input());
    try {
        expect(await host.turn!.recall({ turnId: 'private-turn', query: 'private-query' }))
            .toEqual({ outcome: 'unsupported' });
        expectReason('exception');
        expect(logs()).not.toContain('outcome=ready');
        expect(mocks.close).toHaveBeenCalledOnce();
    } finally {
        await host.close();
    }
});
