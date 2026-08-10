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
import type { AttachmentPreview } from '@/sync/attachmentTypes';

interface NewSessionDraftState {
    input: string;
    attachments: AttachmentPreview[];
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    /**
     * Name for a worktree about to be created, chosen before the session starts
     * so the branch is never a surprise. Deliberately not persisted: a name left
     * over from yesterday silently becoming today's branch is worse than none.
     */
    newWorktreeName: string | null;
    // Bumped when something outside the composer wants it opened — the "+" on a
    // project header, for instance. A counter, not a boolean: two requests in a
    // row have to be two events. Deliberately not persisted.
    composerFocusRequest: number;

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
    setNewWorktreeName: (name: string | null) => void;
    requestComposerFocus: () => void;
}

function persist(state: NewSessionDraftState) {
    saveNewSessionDraft({
        input: state.input,
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
        agentType: state.agentType,
        permissionMode: state.permissionMode,
        modelMode: state.modelMode,
        effortLevel: state.effortLevel,
        sessionType: state.sessionType,
        worktreeKey: state.worktreeKey,
        updatedAt: Date.now(),
    });
}

const initial = loadNewSessionDraft();

export const useNewSessionDraft = create<NewSessionDraftState>()((set, get) => ({
    input: initial?.input ?? '',
    // Image picker URIs are temporary, so attachments intentionally stay out
    // of MMKV persistence and only bridge Home -> New session in memory.
    attachments: [],
    selectedMachineId: initial?.selectedMachineId ?? null,
    selectedPath: initial?.selectedPath ?? null,
    agentType: initial?.agentType ?? 'claude',
    permissionMode: initial?.permissionMode ?? null,
    modelMode: initial?.modelMode ?? null,
    effortLevel: initial?.effortLevel ?? null,
    sessionType: initial?.sessionType ?? 'simple',
    worktreeKey: initial?.worktreeKey ?? null,
    newWorktreeName: null,
    composerFocusRequest: 0,

    setInput: (input) => { set({ input }); persist(get()); },
    setAttachments: (attachments) => { set({ attachments }); },
    setMachineId: (id) => { set({ selectedMachineId: id, selectedPath: null, worktreeKey: null }); persist(get()); },
    setPath: (path) => { set({ selectedPath: path, worktreeKey: null }); persist(get()); },
    setAgentType: (agent) => { set({ agentType: agent }); persist(get()); },
    setPermissionMode: (mode) => { set({ permissionMode: mode }); persist(get()); },
    setModelMode: (mode) => { set({ modelMode: mode }); persist(get()); },
    setEffortLevel: (level) => { set({ effortLevel: level }); persist(get()); },
    setSessionType: (type) => { set({ sessionType: type }); persist(get()); },
    setWorktreeKey: (key) => { set({ worktreeKey: key }); persist(get()); },
    setNewWorktreeName: (name) => { set({ newWorktreeName: name }); },
    requestComposerFocus: () => { set({ composerFocusRequest: get().composerFocusRequest + 1 }); },
}));
