type AttachmentLike = {
    name?: string;
    uri?: string;
    size?: number;
    width?: number;
    height?: number;
    mimeType?: string | null;
};

type AttachmentUploadLogPhase = 'missing_blob_key' | 'upload_failed';

export type AttachmentUploadLogMetadata = {
    phase: AttachmentUploadLogPhase;
    attachmentCount?: number;
    attachmentIndex?: number;
    size?: number;
    width?: number;
    height?: number;
    errorName?: string;
};

export function createAttachmentUploadLogMetadata(input: {
    phase: AttachmentUploadLogPhase;
    attachmentCount?: number;
    attachmentIndex?: number;
    attachment?: AttachmentLike;
    error?: unknown;
    sessionId?: string;
    uploadRef?: string;
}): AttachmentUploadLogMetadata {
    const metadata: AttachmentUploadLogMetadata = {
        phase: input.phase,
    };

    const attachmentCount = input.attachmentCount;
    if (isFiniteNumber(attachmentCount)) {
        metadata.attachmentCount = attachmentCount;
    }

    const attachmentIndex = input.attachmentIndex;
    if (isFiniteNumber(attachmentIndex)) {
        metadata.attachmentIndex = attachmentIndex;
    }

    const size = input.attachment?.size;
    if (isFiniteNumber(size)) {
        metadata.size = size;
    }

    const width = input.attachment?.width;
    if (isFiniteNumber(width) && width > 0) {
        metadata.width = width;
    }

    const height = input.attachment?.height;
    if (isFiniteNumber(height) && height > 0) {
        metadata.height = height;
    }

    if (input.phase === 'upload_failed') {
        metadata.errorName = normalizeErrorName(getErrorName(input.error));
    }

    return metadata;
}

export function formatAttachmentUploadLogMessage(metadata: AttachmentUploadLogMetadata): string {
    return `[attachments] ${metadata.phase}`;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function getErrorName(error: unknown): unknown {
    if (error && typeof error === 'object' && 'name' in error) {
        return (error as { name?: unknown }).name;
    }
    return undefined;
}

function normalizeErrorName(name: unknown): string {
    if (typeof name !== 'string') {
        return 'UnknownError';
    }

    const normalized = name
        .replace(/[^A-Za-z0-9_.:-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80)
        .replace(/^_+|_+$/g, '');

    return normalized || 'UnknownError';
}
