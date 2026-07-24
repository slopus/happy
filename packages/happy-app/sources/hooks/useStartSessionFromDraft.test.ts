import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    machines: [] as Array<{ id: string; online: boolean; metadata?: { homeDir?: string } }>,
    defaultOverrides: {},
    draft: null as any,
    navigateToSession: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    sessionSetAgentModes: vi.fn(),
    refreshSessions: vi.fn(),
    sendMessage: vi.fn(),
    createWorktree: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock('react', () => ({
    useState: <T,>(value: T) => [value, vi.fn()] as const,
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => mocks.machines,
    useSetting: () => mocks.defaultOverrides,
}));

vi.mock('@/sync/agentDefaults', () => ({
    resolveAgentDefaultConfig: () => ({
        permissionMode: 'default',
        modelMode: 'default',
        effortLevel: null,
    }),
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: mocks.machineSpawnNewSession,
    sessionSetAgentModes: mocks.sessionSetAgentModes,
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

vi.mock('@/components/modelModeOptions', () => ({
    getHardcodedPermissionModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'yolo', name: 'YOLO' },
    ],
    getHardcodedModelModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'opus', name: 'Opus' },
    ],
    getEffortLevelsForModel: () => [
        { key: 'medium', name: 'Medium' },
    ],
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

import { useStartSessionFromDraft } from './useStartSessionFromDraft';

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
        mocks.machines = [{ id: 'machine-1', online: true, metadata: { homeDir: '/Users/dev' } }];
        mocks.draft = createDraft();
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        mocks.refreshSessions.mockResolvedValue(undefined);
        mocks.sendMessage.mockResolvedValue(undefined);
        mocks.confirm.mockResolvedValue(false);
    });

    it('creates and opens the session directly from the home draft', async () => {
        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/absolute/project',
            approvedNewDirectoryCreation: false,
            agent: 'codex',
            permissionMode: 'default',
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
