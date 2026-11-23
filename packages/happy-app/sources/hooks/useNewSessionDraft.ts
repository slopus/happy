/**
 * Zustand store for new session draft state, backed by MMKV.
 * Persists the user's last-used configuration (machine, path, model, permissions, etc.)
 * so the new session screen restores the same defaults on next visit.
 */
import { create } from 'zustand';
import {
    loadNewSessionDraft,
    saveNewSessionDraft,
    type NewSessionDraft,
    type DraftModeSelection,
    type NewSessionAgentType,
    type NewSessionSessionType,
} from '@/sync/persistence';
import { storage } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

interface NewSessionDraftState {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey;
    modelMode: string;
    useMagpie?: boolean;
    effortLevel: string | null;
    modelSelection?: DraftModeSelection;
    effortSelection?: DraftModeSelection;
    fastMode: boolean;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;

    setInput: (input: string) => void;
    setMachineId: (id: string | null) => void;
    setPath: (path: string | null) => void;
    setAgentType: (agent: NewSessionAgentType) => void;
    setPermissionMode: (mode: PermissionModeKey) => void;
    setModelMode: (mode: string, useMagpie?: boolean) => void;
    setEffortLevel: (level: string | null) => void;
    reconcileCodexDefaults: () => void;
    setFastMode: (enabled: boolean) => void;
    setSessionType: (type: NewSessionSessionType) => void;
    setWorktreeKey: (key: string | null) => void;
}

function persist(state: NewSessionDraftState) {
    saveNewSessionDraft({
        input: state.input,
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
        agentType: state.agentType,
        permissionMode: state.permissionMode,
        modelMode: state.modelMode,
        useMagpie: state.useMagpie,
        effortLevel: state.effortLevel,
        modelSelection: state.modelSelection,
        effortSelection: state.effortSelection,
        fastMode: state.fastMode,
        sessionType: state.sessionType,
        worktreeKey: state.worktreeKey,
        updatedAt: Date.now(),
    });
}

const initial = loadNewSessionDraft();

export const useNewSessionDraft = create<NewSessionDraftState>()((set, get) => ({
    input: initial?.input ?? '',
    selectedMachineId: initial?.selectedMachineId ?? null,
    selectedPath: initial?.selectedPath ?? null,
    agentType: initial?.agentType ?? 'codex',
    permissionMode: initial?.permissionMode ?? 'default',
    modelMode: initial?.modelMode ?? 'default',
    useMagpie: initial?.useMagpie,
    effortLevel: initial?.effortLevel ?? null,
    modelSelection: initial?.modelSelection,
    effortSelection: initial?.effortSelection,
    fastMode: initial?.fastMode ?? false,
    sessionType: initial?.sessionType ?? 'simple',
    worktreeKey: initial?.worktreeKey ?? null,

    setInput: (input) => { set({ input }); persist(get()); },
    setMachineId: (id) => { set({ selectedMachineId: id, selectedPath: null, worktreeKey: null,
        ...(id !== get().selectedMachineId && get().useMagpie ? { useMagpie: undefined, modelMode: 'default', modelSelection: undefined, fastMode: false } : {}) }); persist(get()); },
    setPath: (path) => { set({ selectedPath: path, worktreeKey: null }); persist(get()); },
    setAgentType: (agent) => {
        if (agent !== get().agentType) set({ agentType: agent, modelSelection: undefined, effortSelection: undefined, useMagpie: undefined });
        persist(get());
    },
    setPermissionMode: (mode) => { set({ permissionMode: mode }); persist(get()); },
    setModelMode: (mode, useMagpie) => {
        const agent = get().agentType;
        const defaults = resolveAgentDefaultConfig(storage.getState().settings.agentDefaultOverrides, agent);
        set({ modelMode: mode, useMagpie, modelSelection: { agent, defaultValue: defaults.modelMode } });
        persist(get());
    },
    setEffortLevel: (level) => {
        const agent = get().agentType;
        const defaults = resolveAgentDefaultConfig(storage.getState().settings.agentDefaultOverrides, agent);
        set({ effortLevel: level, effortSelection: { agent, defaultValue: defaults.effortLevel } });
        persist(get());
    },
    reconcileCodexDefaults: () => {
        const state = get();
        const defaults = resolveAgentDefaultConfig(storage.getState().settings.agentDefaultOverrides, 'codex');
        const resetModel = !state.useMagpie && state.modelSelection?.agent === 'codex' && state.modelSelection.defaultValue !== defaults.modelMode;
        const resetEffort = state.effortSelection?.agent === 'codex' && state.effortSelection.defaultValue !== defaults.effortLevel;
        if (!resetModel && !resetEffort) return;
        set({
            ...(resetModel ? { modelMode: 'default', modelSelection: undefined } : {}),
            ...(resetEffort ? { effortLevel: null, effortSelection: undefined } : {}),
        });
        persist(get());
    },
    setFastMode: (fastMode) => { set({ fastMode }); persist(get()); },
    setSessionType: (type) => { set({ sessionType: type }); persist(get()); },
    setWorktreeKey: (key) => { set({ worktreeKey: key }); persist(get()); },
}));
