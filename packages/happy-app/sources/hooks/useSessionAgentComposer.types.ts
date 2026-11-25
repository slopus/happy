import type { SessionComposerModeSelectorConfig } from '@/components/SessionComposerModeSelector';
import type { Session } from '@/sync/storageTypes';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
export type SessionAgentComposerArgs = {
    session: Session;
    base: SessionComposerModeSelectorConfig;
    readSubmission: () => { prompt: string; images?: AttachmentPreview[]; onQueued?: () => void };
    flushDraft: () => void;
};
export type SessionAgentComposer = {
    modeSelector: SessionComposerModeSelectorConfig;
    permissionSelector?: import("@/hooks/useSessionTaskPermission").SessionTaskPermissionController;
    pendingAgent: string | null;
    sending: boolean;
    disabled: boolean;
    submit: () => Promise<boolean>;
    submitInChat: () => Promise<boolean>;
    submitNewSession: () => Promise<boolean>;
};
