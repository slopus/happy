/**
 * Zustand store for new session draft state, backed by MMKV.
 * Persists the user's last-used configuration (machine, path, agent, model, permissions, etc.)
 * so the new session screen restores the same defaults on next visit.
 */
import { create } from 'zustand';
import {
    loadNewSessionDraft,
    saveNewSessionDraft,
    type NewSessionDraft,
    type NewSessionAgentType,
    type NewSessionSessionType,
} from '@/sync/persistence';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

interface NewSessionDraftState {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey;
    modelMode: string;
    sessionType: NewSessionSessionType;

    setInput: (input: string) => void;
    setMachineId: (id: string | null) => void;
    setPath: (path: string | null) => void;
    setAgentType: (agent: NewSessionAgentType) => void;
    setPermissionMode: (mode: PermissionModeKey) => void;
    setModelMode: (mode: string) => void;
    setSessionType: (type: NewSessionSessionType) => void;
}

function persist(state: NewSessionDraftState) {
    saveNewSessionDraft({
        input: state.input,
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
        agentType: state.agentType,
        permissionMode: state.permissionMode,
        modelMode: state.modelMode,
        sessionType: state.sessionType,
        updatedAt: Date.now(),
    });
}

const initial = loadNewSessionDraft();

export const useNewSessionDraft = create<NewSessionDraftState>()((set, get) => ({
    input: initial?.input ?? '',
    selectedMachineId: initial?.selectedMachineId ?? null,
    selectedPath: initial?.selectedPath ?? null,
    agentType: initial?.agentType ?? 'claude',
    permissionMode: initial?.permissionMode ?? 'default',
    modelMode: initial?.modelMode ?? 'default',
    sessionType: initial?.sessionType ?? 'simple',

    setInput: (input) => { set({ input }); persist(get()); },
    setMachineId: (id) => { set({ selectedMachineId: id, selectedPath: null }); persist(get()); },
    setPath: (path) => { set({ selectedPath: path }); persist(get()); },
    setAgentType: (agent) => { set({ agentType: agent }); persist(get()); },
    setPermissionMode: (mode) => { set({ permissionMode: mode }); persist(get()); },
    setModelMode: (mode) => { set({ modelMode: mode }); persist(get()); },
    setSessionType: (type) => { set({ sessionType: type }); persist(get()); },
}));
