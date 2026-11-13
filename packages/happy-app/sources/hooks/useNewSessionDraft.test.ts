import { describe, expect, it, vi } from 'vitest';

describe('useNewSessionDraft', () => {
    it('restores model, effort and Fast together after leaving and recreating the screen', async () => {
        vi.resetModules();
        const saveNewSessionDraft = vi.fn();
        vi.doMock('@/sync/persistence', () => ({
            loadNewSessionDraft: () => ({
                input: '',
                selectedMachineId: null,
                selectedPath: null,
                agentType: 'codex',
                permissionMode: 'yolo',
                modelMode: 'gpt-5.5',
                effortLevel: 'xhigh',
                fastMode: true,
                sessionType: 'simple',
                worktreeKey: null,
                updatedAt: 1,
            }),
            saveNewSessionDraft,
        }));

        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState()).toMatchObject({ agentType: 'codex', effortLevel: 'xhigh', fastMode: true });
        useNewSessionDraft.getState().setFastMode(false);
        expect(saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: false, effortLevel: 'xhigh' }));
        useNewSessionDraft.getState().setFastMode(true);
        useNewSessionDraft.getState().setModelMode('gpt-6.1-terra');
        expect(saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: true, effortLevel: 'xhigh', modelMode: 'gpt-6.1-terra' }));
    });
});
