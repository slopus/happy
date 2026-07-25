import { beforeEach, describe, expect, it, vi } from 'vitest';

type AgentModes = {
    permissionMode: string | null;
    modelMode: string | null;
    effortLevel: string | null;
};

type Draft = {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy';
    agentModes: Partial<Record<Draft['agentType'], AgentModes>>;
    sessionType: 'simple' | 'worktree';
    worktreeKey: string | null;
    updatedAt: number;
};

const mockPersistence = vi.hoisted(() => ({
    draft: null as Draft | null,
    saved: [] as Draft[],
}));

vi.mock('@/sync/persistence', () => ({
    loadNewSessionDraft: () => mockPersistence.draft,
    saveNewSessionDraft: (draft: Draft) => {
        mockPersistence.saved.push(draft);
        mockPersistence.draft = draft;
    },
}));

function persistedDraft(overrides: Partial<Draft> = {}): Draft {
    return {
        input: '',
        selectedMachineId: null,
        selectedPath: null,
        agentType: 'claude',
        agentModes: {},
        sessionType: 'simple',
        worktreeKey: null,
        updatedAt: 1,
        ...overrides,
    };
}

describe('useNewSessionDraft', () => {
    beforeEach(() => {
        vi.resetModules();
        mockPersistence.draft = null;
        mockPersistence.saved = [];
    });

    it('keeps mode defaults unset when there is no persisted draft', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState().permissionMode).toBeNull();
        expect(useNewSessionDraft.getState().modelMode).toBeNull();
        expect(useNewSessionDraft.getState().effortLevel).toBeNull();
    });

    it('loads persisted permission, model, and effort defaults for the draft agent', async () => {
        mockPersistence.draft = persistedDraft({
            agentModes: {
                claude: { permissionMode: 'yolo', modelMode: 'opus', effortLevel: 'xhigh' },
            },
        });

        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState().permissionMode).toBe('yolo');
        expect(useNewSessionDraft.getState().modelMode).toBe('opus');
        expect(useNewSessionDraft.getState().effortLevel).toBe('xhigh');
    });

    it('persists effort changes with the rest of the new-session draft', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setEffortLevel('high');

        expect(useNewSessionDraft.getState().effortLevel).toBe('high');
        expect(mockPersistence.saved.at(-1)).toMatchObject({
            agentModes: { claude: { effortLevel: 'high' } },
        });
    });

    it('keeps mode selections per agent when switching agents', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setModelMode('claude-opus-5');
        useNewSessionDraft.getState().setPermissionMode('bypassPermissions');

        useNewSessionDraft.getState().setAgentType('codex');
        expect(useNewSessionDraft.getState().modelMode).toBeNull();
        expect(useNewSessionDraft.getState().permissionMode).toBeNull();

        useNewSessionDraft.getState().setModelMode('gpt-5.5');

        useNewSessionDraft.getState().setAgentType('claude');
        expect(useNewSessionDraft.getState().modelMode).toBe('claude-opus-5');
        expect(useNewSessionDraft.getState().permissionMode).toBe('bypassPermissions');

        useNewSessionDraft.getState().setAgentType('codex');
        expect(useNewSessionDraft.getState().modelMode).toBe('gpt-5.5');

        expect(mockPersistence.saved.at(-1)?.agentModes).toEqual({
            claude: { permissionMode: 'bypassPermissions', modelMode: 'claude-opus-5', effortLevel: null },
            codex: { permissionMode: null, modelMode: 'gpt-5.5', effortLevel: null },
        });
    });

    it('clears a remembered selection so a new default can take effect', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setModelMode('opus');
        useNewSessionDraft.getState().setEffortLevel('high');

        useNewSessionDraft.getState().clearAgentMode('claude', 'modelMode');

        expect(useNewSessionDraft.getState().modelMode).toBeNull();
        expect(useNewSessionDraft.getState().effortLevel).toBe('high');
        expect(mockPersistence.saved.at(-1)?.agentModes).toEqual({
            claude: { permissionMode: null, modelMode: null, effortLevel: 'high' },
        });
    });

    it('only clears the flat view when the cleared agent is selected', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setModelMode('opus');
        useNewSessionDraft.getState().setAgentType('codex');
        useNewSessionDraft.getState().setModelMode('gpt-5.5');

        useNewSessionDraft.getState().clearAgentMode('claude', 'modelMode');

        expect(useNewSessionDraft.getState().modelMode).toBe('gpt-5.5');
        expect(mockPersistence.saved.at(-1)?.agentModes).toEqual({
            codex: { permissionMode: null, modelMode: 'gpt-5.5', effortLevel: null },
        });
    });

    it('clears every remembered selection when overrides are reset', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setModelMode('opus');
        useNewSessionDraft.getState().setAgentType('codex');
        useNewSessionDraft.getState().setModelMode('gpt-5.5');

        useNewSessionDraft.getState().clearAllAgentModes();

        expect(useNewSessionDraft.getState().modelMode).toBeNull();
        expect(mockPersistence.saved.at(-1)?.agentModes).toEqual({});
    });

    it('keeps temporary image attachments in memory without persisting their file URIs', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        const attachment = {
            id: 'photo-1',
            uri: 'file:///temporary/photo.jpg',
            width: 100,
            height: 100,
            mimeType: 'image/jpeg',
            size: 1024,
            name: 'photo.jpg',
        };

        useNewSessionDraft.getState().setAttachments([attachment]);

        expect(useNewSessionDraft.getState().attachments).toEqual([attachment]);
        expect(mockPersistence.saved).toHaveLength(0);
    });
});
