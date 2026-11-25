export type VideoSaveResult = 'saved' | 'shared' | 'downloaded';
export type VideoSaveOptions = import('./attachmentTransfer').AttachmentTransferOptions & {
    onPhase?: (phase: 'downloading' | 'saving' | 'sharing') => void;
};
