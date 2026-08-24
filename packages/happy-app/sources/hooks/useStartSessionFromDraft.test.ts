import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    machines: [] as Array<{
        id: string;
        online: boolean;
        metadata?: any;
    }>,
    defaultOverrides: {},
    experiments: true,
    draft: null as any,
    navigateToSession: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    sessionSetAgentModes: vi.fn(),
    refreshSessions: vi.fn(),
    sendMessage: vi.fn(),
    createWorktree: vi.fn(),
    machineStopSession: vi.fn(),
    sessionKill: vi.fn(),
    sessionArchive: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    delay: vi.fn(),
    uuidCount: 0,
}));

// Counts up so a test can tell a reused idempotency key from a fresh one.
vi.mock('expo-crypto', () => ({ randomUUID: () => `rig-request-${++mocks.uuidCount}` }));

vi.mock('react', () => ({
    useState: <T,>(value: T) => [value, vi.fn()] as const,
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => { effect(); },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => mocks.machines,
    useSetting: (key: string) => key === 'experiments' ? mocks.experiments : mocks.defaultOverrides,
}));

vi.mock('@/sync/agentDefaults', () => ({
    resolveAgentDefaultConfig: (
        overrides: Record<string, unknown>,
        agentType: string,
    ) => overrides[agentType] ?? ({
        permissionMode: 'default',
        modelMode: 'default',
        effortLevel: null,
    }),
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: mocks.machineSpawnNewSession,
    sessionSetAgentModes: mocks.sessionSetAgentModes,
    machineStopSession: mocks.machineStopSession,
    sessionKill: mocks.sessionKill,
    sessionArchive: mocks.sessionArchive,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshSessions: mocks.refreshSessions,
        sendMessage: mocks.sendMessage,
    },
}));

vi.mock('@/hooks/useNewSessionDraft', () => ({
    useNewSessionDraft: {
        getState: () => mocks.draft,
    },
}));

vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));

vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: (machine: { online: boolean }) => machine.online,
}));

vi.mock('@/utils/pathUtils', () => ({
    resolveAbsolutePath: (path: string) => `/absolute/${path.replace(/^~\/?/, '')}`,
}));

vi.mock('@/utils/worktree', () => ({
    createWorktree: mocks.createWorktree,
}));

vi.mock('@/utils/time', () => ({ delay: mocks.delay }));

vi.mock('@/components/modelModeOptions', () => ({
    getHardcodedPermissionModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'safe-yolo', name: 'Safe YOLO' },
        { key: 'yolo', name: 'YOLO' },
    ],
    getHardcodedModelModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'opus', name: 'Opus' },
    ],
    getEffortLevelsForModel: () => [
        { key: 'medium', name: 'Medium' },
    ],
    includeConfiguredModel: (
        flavor: string,
        models: Array<{ key: string; name: string }>,
        configuredModelKey?: string | null,
    ) => flavor === 'codex'
        && configuredModelKey
        && configuredModelKey !== 'default'
        && !models.some((model) => model.key === configuredModelKey)
        ? [...models, { key: configuredModelKey, name: configuredModelKey }]
        : models,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.alert,
        confirm: mocks.confirm,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { completeSpawnRequest } from '@/sync/spawnRequestId';
import { useStartSessionFromDraft } from './useStartSessionFromDraft';

function createRigMachine(metadata: Record<string, unknown> = {}) {
    return {
        id: 'machine-1',
        online: true,
        metadata: {
            homeDir: '/Users/dev',
            machineKind: 'rig',
            rigOnly: true,
            cliAvailability: {
                rig: true,
                claude: false,
                codex: false,
                gemini: false,
                openclaw: false,
                detectedAt: 1,
            },
            capabilities: { newSession: true, resume: false, worktrees: false },
            defaults: {
                providerId: 'codex', modelId: 'model', permissionMode: 'auto', effort: 'high',
            },
            models: [{
                providerId: 'codex', id: 'model', name: 'Model', providerName: 'Codex',
                thinkingLevels: ['high'], defaultThinkingLevel: 'high',
            }],
            operatingModes: [{
                code: 'auto', value: 'Auto', description: 'Automatic review', kind: 'safe-yolo',
            }],
            ...metadata,
        },
    };
}

function createDraft(overrides: Record<string, unknown> = {}) {
    return {
        input: ' Start the implementation ',
        attachments: [{ uri: 'file:///image.jpg' }],
        selectedMachineId: 'machine-1',
        selectedPath: '~/project',
        agentType: 'codex',
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
        sessionType: 'simple',
        worktreeKey: null,
        setInput: vi.fn(),
        setAttachments: vi.fn(),
        ...overrides,
    };
}

describe('useStartSessionFromDraft', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.uuidCount = 0;
        completeSpawnRequest();
        mocks.defaultOverrides = {};
        mocks.experiments = true;
        mocks.machines = [{ id: 'machine-1', online: true, metadata: { homeDir: '/Users/dev' } }];
        mocks.draft = createDraft();
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        mocks.refreshSessions.mockResolvedValue(undefined);
        mocks.sendMessage.mockResolvedValue(undefined);
        mocks.confirm.mockResolvedValue(false);
        mocks.machineStopSession.mockResolvedValue({ success: true });
        mocks.sessionKill.mockResolvedValue({ success: true });
        mocks.sessionArchive.mockResolvedValue({ success: true });
    });

    it('creates and opens the session directly from the home draft', async () => {
        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/absolute/project',
            approvedNewDirectoryCreation: false,
            agent: 'codex',
            // Default is the absence of an override, for codex as much as for
            // claude: sending it would replace the harness's own configured
            // mode with one specific mode.
            permissionMode: undefined,
            modelMode: undefined,
            effortLevel: 'medium',
        });
        expect(mocks.refreshSessions).toHaveBeenCalledOnce();
        expect(mocks.draft.setInput).toHaveBeenCalledWith('');
        expect(mocks.draft.setAttachments).toHaveBeenCalledWith([]);
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-1');
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'session-1',
            'Start the implementation',
            { source: 'new_session', attachments: mocks.draft.attachments },
        );
        expect(mocks.navigateToSession.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.sendMessage.mock.invocationCallOrder[0]);
    });

    it('starts codex with a custom model saved in agent settings', async () => {
        mocks.defaultOverrides = {
            codex: {
                permissionMode: 'default',
                modelMode: 'my-workspace-model',
                effortLevel: 'medium',
            },
        };

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex',
            modelMode: 'my-workspace-model',
        }));
    });

    it('does not spawn a stale Claude draft when the machine only has Codex', async () => {
        mocks.defaultOverrides = {
            codex: {
                permissionMode: 'safe-yolo',
                modelMode: 'default',
                effortLevel: 'medium',
            },
        };
        mocks.machines = [{
            id: 'machine-1',
            online: true,
            metadata: {
                homeDir: '/Users/dev',
                cliAvailability: {
                    claude: false,
                    codex: true,
                    gemini: false,
                    openclaw: false,
                },
            },
        }];
        mocks.draft = createDraft({
            agentType: 'claude',
            permissionMode: 'yolo',
            modelMode: 'opus',
        });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex',
            permissionMode: 'safe-yolo',
            modelMode: undefined,
            effortLevel: 'medium',
        }));
    });

    it('retries creation after the user approves a new directory', async () => {
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/absolute/project' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-2' });
        mocks.confirm.mockResolvedValue(true);

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
            approvedNewDirectoryCreation: false,
        }));
        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
            approvedNewDirectoryCreation: true,
        }));
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-2');
    });

    it('creates a Rig session from its machine catalog and retries pending idempotently', async () => {
        mocks.machines = [{
            id: 'machine-1',
            online: true,
            metadata: {
                homeDir: '/Users/dev',
                machineKind: 'rig',
                rigOnly: true,
                cliAvailability: {
                    rig: true,
                    claude: false,
                    codex: false,
                    gemini: false,
                    openclaw: false,
                    detectedAt: 1,
                },
                capabilities: { newSession: true, resume: false, worktrees: false },
                defaults: {
                    providerId: 'codex',
                    modelId: 'gpt-5.6-sol',
                    permissionMode: 'auto',
                    effort: 'high',
                },
                models: [{
                    providerId: 'codex',
                    id: 'gpt-5.6-sol',
                    name: 'GPT-5.6 Sol',
                    providerName: 'OpenAI Codex',
                    thinkingLevels: ['low', 'high'],
                    defaultThinkingLevel: 'high',
                }],
                operatingModes: [{
                    code: 'auto',
                    value: 'Auto',
                    description: 'Reviews elevated actions.',
                    kind: 'safe-yolo',
                }],
            },
        }];
        mocks.draft = createDraft({
            agentType: 'claude',
            sessionType: 'worktree',
            worktreeKey: null,
        });
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'pending', clientRequestId: 'rig-request-1', retryAfterMs: 0 })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'rig-session-1' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        const expected = expect.objectContaining({
            machineId: 'machine-1',
            agent: 'rig',
            clientRequestId: 'rig-request-1',
            directory: '/absolute/project',
            providerId: 'codex',
            modelId: 'gpt-5.6-sol',
            permissionMode: 'auto',
            effort: 'high',
        });
        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(1, expected);
        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(2, expected);
        expect(mocks.delay).toHaveBeenCalledWith(250);
        expect(mocks.createWorktree).not.toHaveBeenCalled();
        expect(mocks.sessionSetAgentModes).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).toHaveBeenCalledWith('rig-session-1');
    });

    it('stops polling when a created Rig session remains pending', async () => {
        mocks.machines = [{
            id: 'machine-1',
            online: true,
            metadata: {
                homeDir: '/Users/dev',
                machineKind: 'rig',
                rigOnly: true,
                cliAvailability: {
                    rig: true,
                    claude: false,
                    codex: false,
                    gemini: false,
                    openclaw: false,
                    detectedAt: 1,
                },
                capabilities: { newSession: true, resume: false, worktrees: false },
                defaults: {
                    providerId: 'codex', modelId: 'model', permissionMode: 'auto', effort: 'high',
                },
                models: [{
                    providerId: 'codex', id: 'model', name: 'Model', providerName: 'Codex',
                    thinkingLevels: ['high'], defaultThinkingLevel: 'high',
                }],
                operatingModes: [{
                    code: 'auto', value: 'Auto', description: 'Automatic review', kind: 'safe-yolo',
                }],
            },
        }];
        mocks.draft = createDraft({ agentType: 'rig' });
        mocks.machineSpawnNewSession.mockResolvedValue({
            type: 'pending', clientRequestId: 'rig-request-1', retryAfterMs: 2_000,
        });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(4);
        expect(mocks.delay).toHaveBeenCalledTimes(3);
        expect(mocks.alert).toHaveBeenCalledWith(
            'common.error',
            'The session was created, but it is still syncing. It should appear shortly.',
        );
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
    });

    it('degrades instead of crashing when a Rig machine publishes no operating modes', async () => {
        mocks.machines = [createRigMachine({ operatingModes: [] })];
        mocks.draft = createDraft({ agentType: 'rig' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);
        expect(mocks.alert).toHaveBeenCalledWith(
            'common.error',
            'The selected agent configuration is unavailable',
        );
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
    });

    it('does not start a Happy harness session while experiments are disabled', async () => {
        mocks.experiments = false;
        mocks.machines = [createRigMachine()];
        mocks.draft = createDraft({ agentType: 'rig' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith(
            'common.error',
            'This computer has no Happy CLI daemon to start that agent',
        );
    });

    it('reuses the idempotency key when the user retries the same spawn', async () => {
        mocks.machines = [createRigMachine()];
        mocks.draft = createDraft({ agentType: 'rig' });
        mocks.machineSpawnNewSession.mockResolvedValue({
            type: 'pending', clientRequestId: 'rig-request-1', retryAfterMs: 250,
        });

        const { startSession } = useStartSessionFromDraft();

        // Rig stayed pending past the retry budget, so the user presses Start again.
        await expect(startSession()).resolves.toBe(false);
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'rig-session-1' });
        await expect(startSession()).resolves.toBe(true);

        const requestIds = mocks.machineSpawnNewSession.mock.calls
            .map(([options]) => options.clientRequestId);
        expect(new Set(requestIds)).toEqual(new Set(['rig-request-1']));

        // The spawn succeeded, so the next one is a genuinely new session.
        await expect(startSession()).resolves.toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenLastCalledWith(expect.objectContaining({
            clientRequestId: 'rig-request-2',
        }));
    });

    // A machine that has gone quiet never answers, and the composer cannot be
    // held hostage by it: Stop has to be the end of the wait, not a request to
    // be considered once the machine gets around to replying.
    it('gives the composer back the moment Stop is pressed, even mid-worktree', async () => {
        mocks.draft = createDraft({ sessionType: 'worktree', worktreeKey: '__new__' });
        mocks.createWorktree.mockReturnValue(new Promise(() => { }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const starting = startSession();
        cancelStart();

        await expect(starting).resolves.toBe(false);
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.draft.setInput).not.toHaveBeenCalled();
    });

    it('stops the session that lands after Stop was already pressed', async () => {
        let landSpawn!: (result: unknown) => void;
        mocks.machineSpawnNewSession.mockReturnValue(new Promise((resolve) => {
            landSpawn = resolve;
        }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const starting = startSession();
        cancelStart();
        await expect(starting).resolves.toBe(false);
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();

        // The machine was already spawning when Stop landed; nobody is on the
        // screen any more, so the session is put down without them.
        landSpawn({ type: 'success', sessionId: 'session-late' });
        await vi.waitFor(() => {
            expect(mocks.machineStopSession).toHaveBeenCalledWith('machine-1', 'session-late');
        });
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
    });

    it('archives an abandoned session the daemon and the session both refuse', async () => {
        mocks.machineStopSession.mockResolvedValue({ success: false });
        mocks.sessionKill.mockResolvedValue({ success: false });
        let landSpawn!: (result: unknown) => void;
        mocks.machineSpawnNewSession.mockReturnValue(new Promise((resolve) => {
            landSpawn = resolve;
        }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const starting = startSession();
        cancelStart();
        await expect(starting).resolves.toBe(false);

        landSpawn({ type: 'success', sessionId: 'session-late' });
        await vi.waitFor(() => {
            expect(mocks.sessionArchive).toHaveBeenCalledWith('session-late');
        });
    });

    // The failure this guards against: an await that never returns held the
    // flow open, so the composer stayed stuck and every later Start was
    // refused as "already starting". Stop must let go of the flow itself, not
    // ask the flow to notice and let go on its way past.
    it('frees the composer for a new Start even while the old one never settles', async () => {
        mocks.draft = createDraft({ sessionType: 'worktree', worktreeKey: '__new__' });
        mocks.createWorktree.mockReturnValueOnce(new Promise(() => { }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const abandoned = startSession();
        cancelStart();
        await expect(abandoned).resolves.toBe(false);

        // Nothing ever answered the first attempt — it is still sitting on that
        // promise — and the next Start still goes through.
        mocks.createWorktree.mockResolvedValue({
            success: true, worktreePath: '/absolute/project/.dev/worktree/w', branchName: 'w',
        });
        await expect(startSession()).resolves.toBe(true);
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-1');
    });

    // A step of the abandoned attempt finishing late must not raise a spinner
    // over a composer that has already been handed back.
    it('lets a late step of a canceled attempt touch nothing', async () => {
        let finishWorktree!: (result: unknown) => void;
        mocks.draft = createDraft({ sessionType: 'worktree', worktreeKey: '__new__' });
        mocks.createWorktree.mockReturnValueOnce(new Promise((resolve) => {
            finishWorktree = resolve;
        }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const abandoned = startSession();
        cancelStart();
        await expect(abandoned).resolves.toBe(false);

        finishWorktree({
            success: true, worktreePath: '/absolute/project/.dev/worktree/late', branchName: 'late',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
    });

    it('gives the next Start a fresh key after a Stop', async () => {
        mocks.machines = [createRigMachine()];
        mocks.draft = createDraft({ agentType: 'rig' });
        mocks.machineSpawnNewSession.mockReturnValue(new Promise(() => { }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const starting = startSession();
        cancelStart();
        await expect(starting).resolves.toBe(false);

        // The stopped session's key is spent — reusing it would dedupe the
        // retry straight back onto the session just killed.
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'rig-session-2' });
        await expect(startSession()).resolves.toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenLastCalledWith(expect.objectContaining({
            clientRequestId: 'rig-request-2',
        }));
    });

    // Stop hands the composer back synchronously, so a retry can be pressed
    // before the canceled attempt has resumed even once. If the key were still
    // pending at that moment the machine would dedupe the retry straight onto
    // the session the cancel is busy killing.
    it('does not hand the canceled key to a Start pressed on the same tick', async () => {
        mocks.machines = [createRigMachine()];
        mocks.draft = createDraft({ agentType: 'rig' });
        let landFirstSpawn!: (result: unknown) => void;
        mocks.machineSpawnNewSession.mockReturnValueOnce(new Promise((resolve) => {
            landFirstSpawn = resolve;
        }));

        const { startSession, cancelStart } = useStartSessionFromDraft();

        const abandoned = startSession();
        cancelStart();

        // No await in between: the canceled attempt has not resumed yet.
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'rig-session-2' });
        const retry = startSession();

        await expect(abandoned).resolves.toBe(false);
        await expect(retry).resolves.toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenLastCalledWith(expect.objectContaining({
            clientRequestId: 'rig-request-2',
        }));

        // The first attempt's session still gets put down, and the retry's is
        // left alone.
        landFirstSpawn({ type: 'success', sessionId: 'rig-session-1' });
        await vi.waitFor(() => {
            expect(mocks.machineStopSession).toHaveBeenCalledWith('machine-1', 'rig-session-1');
        });
        expect(mocks.machineStopSession).not.toHaveBeenCalledWith('machine-1', 'rig-session-2');
    });

    it('backs off with the published delay when a pending result omits one', async () => {
        mocks.machines = [createRigMachine({
            sessionCreation: {
                idempotencyKey: 'clientRequestId',
                pendingRetryAfterMs: 4_000,
                resultKinds: ['success', 'pending'],
            },
        })];
        mocks.draft = createDraft({ agentType: 'rig' });
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'pending', clientRequestId: 'rig-request-1' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'rig-session-1' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);
        expect(mocks.delay).toHaveBeenCalledWith(4_000);
    });

    it('keeps the draft in place when creation fails', async () => {
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'error', errorMessage: 'Machine rejected the request' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);

        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'Machine rejected the request');
        expect(mocks.draft.setInput).not.toHaveBeenCalled();
        expect(mocks.draft.setAttachments).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });
});
