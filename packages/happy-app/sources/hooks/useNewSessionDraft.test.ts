import { describe, expect, it, vi } from 'vitest';

describe('useNewSessionDraft', () => {
    it('restores model, effort and Fast together after leaving and recreating the screen', async () => {
        vi.resetModules();
        vi.doMock('@/sync/storage', () => ({ storage: { getState: () => ({ settings: { agentDefaultOverrides: {} } }) } }));
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
                modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
                effortSelection: { agent: 'codex', defaultValue: 'medium' },
                fastMode: true,
                sessionType: 'simple',
                worktreeKey: null,
                updatedAt: 1,
            }),
            saveNewSessionDraft,
        }));

        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState()).toMatchObject({ agentType: 'codex', effortLevel: 'xhigh', fastMode: true });
        expect(useNewSessionDraft.getState().modelSelection).toEqual({ agent: 'codex', defaultValue: 'gpt-6.1-sol' });
        useNewSessionDraft.getState().reconcileCodexDefaults();
        expect(useNewSessionDraft.getState()).toMatchObject({ modelMode: 'gpt-5.5', effortLevel: 'xhigh' });
        useNewSessionDraft.getState().setFastMode(false);
        expect(saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: false, effortLevel: 'xhigh' }));
        useNewSessionDraft.getState().setFastMode(true);
        useNewSessionDraft.getState().setModelMode('gpt-6.1-terra');
        expect(saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: true, effortLevel: 'xhigh', modelMode: 'gpt-6.1-terra', modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' } }));
        useNewSessionDraft.getState().setEffortLevel('ultra');
        expect(saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ effortLevel: 'ultra', effortSelection: { agent: 'codex', defaultValue: 'medium' } }));
        useNewSessionDraft.getState().setAgentType('claude');
        expect(useNewSessionDraft.getState()).toMatchObject({ modelSelection: undefined, effortSelection: undefined });
    });
    it('clears obsolete intent so changing defaults back cannot resurrect a previous pick', async () => {
        vi.resetModules();
        const settings = { agentDefaultOverrides: { codex: { modelMode: 'gpt-6.1-sol', effortLevel: 'medium' } } };
        vi.doMock('@/sync/storage', () => ({ storage: { getState: () => ({ settings }) } }));
        vi.doMock('@/sync/persistence', () => ({ loadNewSessionDraft: () => null, saveNewSessionDraft: vi.fn() }));
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        useNewSessionDraft.getState().setModelMode('gpt-5.5');
        useNewSessionDraft.getState().setEffortLevel('low');
        settings.agentDefaultOverrides.codex.effortLevel = 'ultra';
        useNewSessionDraft.getState().reconcileCodexDefaults();
        expect(useNewSessionDraft.getState()).toMatchObject({ modelMode: 'gpt-5.5', effortLevel: null, effortSelection: undefined });
        settings.agentDefaultOverrides.codex.effortLevel = 'medium';
        useNewSessionDraft.getState().reconcileCodexDefaults();
        expect(useNewSessionDraft.getState().effortSelection).toBeUndefined();
        settings.agentDefaultOverrides.codex.modelMode = 'gpt-6-astra';
        useNewSessionDraft.getState().reconcileCodexDefaults();
        expect(useNewSessionDraft.getState()).toMatchObject({ modelMode: 'default', modelSelection: undefined });
        useNewSessionDraft.getState().setModelMode('gpt-6.1-sol');
        expect(useNewSessionDraft.getState().modelSelection).toEqual({ agent: 'codex', defaultValue: 'gpt-6-astra' });
    });

});
