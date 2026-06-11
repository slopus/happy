type AttachmentSupportSession = {
    metadata?: {
        flavor?: string | null;
        claudeRuntime?: {
            kind?: string;
            state?: string;
            backend?: string;
            capabilities?: string[];
            claudeSessionId?: string;
            terminalId?: string;
            message?: string;
            updatedAt?: number;
        };
    } | null;
};

export type AttachmentUnsupportedTextKey =
    | 'imageUpload.notSupportedMessage'
    | 'imageUpload.interactiveClaudeNotSupportedMessage';

export function getAttachmentSupportForSession(session: AttachmentSupportSession): {
    supportsAttachments: boolean;
    unsupportedTextKey: AttachmentUnsupportedTextKey;
} {
    const flavor = session.metadata?.flavor;
    const isInteractiveClaudeRemote = flavor === 'claude'
        && session.metadata?.claudeRuntime?.kind === 'interactive';

    return {
        supportsAttachments: (!flavor || flavor === 'claude') && !isInteractiveClaudeRemote,
        unsupportedTextKey: isInteractiveClaudeRemote
            ? 'imageUpload.interactiveClaudeNotSupportedMessage'
            : 'imageUpload.notSupportedMessage',
    };
}

export function shouldSendTextAfterDroppingAttachments(text: string): boolean {
    return text.trim().length > 0;
}
