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
import { rollBotFaceSeeds, type BotFaceSeeds, type BotFaceSlot } from '@/utils/botFace';

interface NewSessionDraftState {
    input: string;
    attachments: AttachmentPreview[];
    selectedMachineId: string | null;
    selectedPath: string | null;
    /**
     * The project the draft names, for a project whose folder only Happy Agent's catalog knows.
     * Exactly one of this and `selectedPath` describes where the session starts; setting either
     * clears the other, so the draft never names two places at once.
     */
    selectedProjectId: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    /**
     * The composer is making a new bot rather than a session in the project.
     * Sits on top of the project choice, which stays what it was, and is not
     * persisted: a restarted app should offer a session, the ordinary case.
     */
    createsBot: boolean;
    /** What the bot will be called. Typed into the composer's own input while making a bot. */
    botName: string;
    /** The four faces on offer; `botFaceSlot` says which one the bot gets. */
    botFaceSeeds: BotFaceSeeds;
    botFaceSlot: BotFaceSlot;

    setInput: (input: string) => void;
    setAttachments: (attachments: AttachmentPreview[]) => void;
    setMachineId: (id: string | null) => void;
    /**
     * Renames the machine this draft already points at, keeping everything chosen on it.
     *
     * Picking a different computer throws the directory away, because a path on one laptop means
     * nothing on another. Discovering that two machine ids were one computer all along is the
     * opposite: the same folder, under the name it should have had.
     */
    renameMachineId: (id: string | null) => void;
    setPath: (path: string | null) => void;
    /** Names a catalog project as the place, in place of whatever directory was chosen before. */
    setProjectId: (id: string | null) => void;
    setAgentType: (agent: NewSessionAgentType) => void;
    setPermissionMode: (mode: PermissionModeKey) => void;
    setModelMode: (mode: string) => void;
    setEffortLevel: (level: string) => void;
    setSessionType: (type: NewSessionSessionType) => void;
    setWorktreeKey: (key: string | null) => void;
    setCreatesBot: (createsBot: boolean) => void;
    setBotName: (name: string) => void;
    /** Picks one of the four faces by position. */
    setBotFaceSlot: (slot: BotFaceSlot) => void;
    /** Rolls four new faces. The picked position stays picked, now wearing its new face. */
    rollBotFaces: () => void;
}

function persist(state: NewSessionDraftState) {
    saveNewSessionDraft({
        input: state.input,
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
        selectedProjectId: state.selectedProjectId,
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
    selectedProjectId: initial?.selectedProjectId ?? null,
    agentType: initial?.agentType ?? 'claude',
    permissionMode: initial?.permissionMode ?? null,
    modelMode: initial?.modelMode ?? null,
    effortLevel: initial?.effortLevel ?? null,
    sessionType: initial?.sessionType ?? 'simple',
    worktreeKey: initial?.worktreeKey ?? null,
    createsBot: false,
    botName: '',
    botFaceSeeds: rollBotFaceSeeds(),
    botFaceSlot: 0,

    setInput: (input) => { set({ input }); persist(get()); },
    setAttachments: (attachments) => { set({ attachments }); },
    setMachineId: (id) => { set({ selectedMachineId: id, selectedPath: null, selectedProjectId: null, worktreeKey: null }); persist(get()); },
    renameMachineId: (id) => { set({ selectedMachineId: id }); persist(get()); },
    setPath: (path) => { set({ selectedPath: path, selectedProjectId: null, worktreeKey: null }); persist(get()); },
    setProjectId: (id) => { set({ selectedProjectId: id, selectedPath: null, worktreeKey: null }); persist(get()); },
    setAgentType: (agent) => { set({ agentType: agent }); persist(get()); },
    setPermissionMode: (mode) => { set({ permissionMode: mode }); persist(get()); },
    setModelMode: (mode) => { set({ modelMode: mode }); persist(get()); },
    setEffortLevel: (level) => { set({ effortLevel: level }); persist(get()); },
    setSessionType: (type) => { set({ sessionType: type }); persist(get()); },
    setWorktreeKey: (key) => { set({ worktreeKey: key }); persist(get()); },
    setCreatesBot: (createsBot) => { set({ createsBot }); },
    setBotName: (botName) => { set({ botName }); },
    setBotFaceSlot: (botFaceSlot) => { set({ botFaceSlot }); },
    rollBotFaces: () => { set({ botFaceSeeds: rollBotFaceSeeds() }); },
}));
