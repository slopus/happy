export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}
