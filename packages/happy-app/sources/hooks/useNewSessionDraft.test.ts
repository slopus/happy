import { beforeEach, describe, expect, it, vi } from 'vitest';

type Draft = {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy' | 'rig';
    pickedAgentType?: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy' | 'rig' | null;
    permissionMode: string | null;
    modelMode: string | null;
    effortLevel: string | null;
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
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
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
        expect(useNewSessionDraft.getState().agentType).toBe('claude');
    });

    it.each(['claude', 'codex', 'rig'] as const)('preserves the saved %s selection', async (agentType) => {
        mockPersistence.draft = persistedDraft({ agentType });
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        expect(useNewSessionDraft.getState().agentType).toBe(agentType);
    });

    it('treats a draft saved before picks were remembered as having no pick', async () => {
        // Its claude is mostly the old implicit default, so Happy should still win.
        mockPersistence.draft = persistedDraft({ agentType: 'claude' });
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        expect(useNewSessionDraft.getState().pickedAgentType).toBeNull();
    });

    it('persists a harness tapped in the composer', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().pickAgentType('codex');
        expect(useNewSessionDraft.getState()).toMatchObject({ agentType: 'codex', pickedAgentType: 'codex' });
        expect(mockPersistence.saved.at(-1)).toMatchObject({ agentType: 'codex', pickedAgentType: 'codex' });
    });

    it('restores the pick after a reload', async () => {
        const first = await import('./useNewSessionDraft');
        first.useNewSessionDraft.getState().pickAgentType('codex');

        vi.resetModules();
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        expect(useNewSessionDraft.getState()).toMatchObject({ agentType: 'codex', pickedAgentType: 'codex' });
    });

    it('keeps the pick when the composer follows a computer to a different harness', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().pickAgentType('codex');
        useNewSessionDraft.getState().setAgentType('claude');
        expect(useNewSessionDraft.getState()).toMatchObject({ agentType: 'claude', pickedAgentType: 'codex' });
        expect(mockPersistence.saved.at(-1)).toMatchObject({ agentType: 'claude', pickedAgentType: 'codex' });
    });

    it('loads persisted permission, model, and effort defaults', async () => {
        mockPersistence.draft = persistedDraft({
            permissionMode: 'yolo',
            modelMode: 'opus',
            effortLevel: 'xhigh',
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
        expect(mockPersistence.saved.at(-1)).toMatchObject({ effortLevel: 'high' });
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
