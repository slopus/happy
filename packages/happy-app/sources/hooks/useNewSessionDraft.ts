/**
 * Zustand store for new session draft state, backed by MMKV.
 * Persists the user's last-used configuration (machine, path, agent, model, permissions, etc.)
 * so the new session screen restores the same defaults on next visit.
 *
 * Mode selections (permission/model/effort) are stored per agent: the flat
 * `permissionMode`/`modelMode`/`effortLevel` fields always reflect the
 * currently selected agent, and switching agents swaps that view instead of
 * overwriting the selections made for another agent.
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
import type { AttachmentPreview } from '@/sync/attachmentTypes';

interface NewSessionDraftState {
    input: string;
    attachments: AttachmentPreview[];
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    agentModes: NewSessionDraft['agentModes'];
    permissionMode: PermissionModeKey | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;

    setInput: (input: string) => void;
    setAttachments: (attachments: AttachmentPreview[]) => void;
    setMachineId: (id: string | null) => void;
    setPath: (path: string | null) => void;
    setAgentType: (agent: NewSessionAgentType) => void;
    setPermissionMode: (mode: PermissionModeKey) => void;
    setModelMode: (mode: string) => void;
    setEffortLevel: (level: string) => void;
    setSessionType: (type: NewSessionSessionType) => void;
    setWorktreeKey: (key: string | null) => void;
    clearAgentMode: (agent: NewSessionAgentType, field: AgentModeField) => void;
    clearAllAgentModes: () => void;
}

type AgentModeField = 'permissionMode' | 'modelMode' | 'effortLevel';

function persist(state: NewSessionDraftState) {
    saveNewSessionDraft({
        input: state.input,
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
        agentType: state.agentType,
        agentModes: state.agentModes,
        sessionType: state.sessionType,
        worktreeKey: state.worktreeKey,
        updatedAt: Date.now(),
    });
}

function updateAgentMode(
    state: NewSessionDraftState,
    patch: Partial<Pick<NewSessionDraftState, 'permissionMode' | 'modelMode' | 'effortLevel'>>,
): Partial<NewSessionDraftState> {
    const current = state.agentModes[state.agentType];
    return {
        ...patch,
        agentModes: {
            ...state.agentModes,
            [state.agentType]: {
                permissionMode: patch.permissionMode ?? current?.permissionMode ?? null,
                modelMode: patch.modelMode ?? current?.modelMode ?? null,
                effortLevel: patch.effortLevel ?? current?.effortLevel ?? null,
            },
        },
    };
}

const initial = loadNewSessionDraft();
const initialAgent = initial?.agentType ?? 'claude';
const initialModes = initial?.agentModes?.[initialAgent];

export const useNewSessionDraft = create<NewSessionDraftState>()((set, get) => ({
    input: initial?.input ?? '',
    // Image picker URIs are temporary, so attachments intentionally stay out
    // of MMKV persistence and only bridge Home -> New session in memory.
    attachments: [],
    selectedMachineId: initial?.selectedMachineId ?? null,
    selectedPath: initial?.selectedPath ?? null,
    agentType: initialAgent,
    agentModes: initial?.agentModes ?? {},
    permissionMode: initialModes?.permissionMode ?? null,
    modelMode: initialModes?.modelMode ?? null,
    effortLevel: initialModes?.effortLevel ?? null,
    sessionType: initial?.sessionType ?? 'simple',
    worktreeKey: initial?.worktreeKey ?? null,

    setInput: (input) => { set({ input }); persist(get()); },
    setAttachments: (attachments) => { set({ attachments }); },
    setMachineId: (id) => { set({ selectedMachineId: id, selectedPath: null, worktreeKey: null }); persist(get()); },
    setPath: (path) => { set({ selectedPath: path, worktreeKey: null }); persist(get()); },
    setAgentType: (agent) => {
        const modes = get().agentModes[agent];
        set({
            agentType: agent,
            permissionMode: modes?.permissionMode ?? null,
            modelMode: modes?.modelMode ?? null,
            effortLevel: modes?.effortLevel ?? null,
        });
        persist(get());
    },
    setPermissionMode: (mode) => { set(updateAgentMode(get(), { permissionMode: mode })); persist(get()); },
    setModelMode: (mode) => { set(updateAgentMode(get(), { modelMode: mode })); persist(get()); },
    setEffortLevel: (level) => { set(updateAgentMode(get(), { effortLevel: level })); persist(get()); },
    setSessionType: (type) => { set({ sessionType: type }); persist(get()); },
    setWorktreeKey: (key) => { set({ worktreeKey: key }); persist(get()); },
    // Drop a remembered selection so a newly configured agent default isn't
    // shadowed by it (the draft always wins over defaults when resolving).
    clearAgentMode: (agent, field) => {
        const state = get();
        const current = state.agentModes[agent];
        if (!current) {
            return;
        }
        const nextEntry = { ...current, [field]: null };
        const agentModes = { ...state.agentModes };
        if (nextEntry.permissionMode === null && nextEntry.modelMode === null && nextEntry.effortLevel === null) {
            delete agentModes[agent];
        } else {
            agentModes[agent] = nextEntry;
        }
        set({
            agentModes,
            ...(state.agentType === agent ? { [field]: null } : {}),
        });
        persist(get());
    },
    clearAllAgentModes: () => {
        set({ agentModes: {}, permissionMode: null, modelMode: null, effortLevel: null });
        persist(get());
    },
}));
