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

const TOKEN_LIKE_PATTERN = /(^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{3,}|gh[pousr]_[A-Za-z0-9_]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|(?:token|secret|api[_-]?key|authorization|bearer)(?:$|[^A-Za-z0-9]))/i;
const URL_LIKE_PATTERN = /\b(?:blob|data|file|ftp|https?|mailto):/i;
const UNIX_PATH_PATTERN = /(?:^|[\s'"(])(?:~|\/(?:Applications|Users|Volumes|etc|home|opt|private|tmp|var))\//i;
const WINDOWS_PATH_PATTERN = /(?:^|[\s'"(])[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+[\\/]/;
const FILENAME_PATTERN = /(?:^|[\\/ \t])[^\\/ \t]+\.(?:bmp|gif|gz|heic|heif|jpeg|jpg|json|log|mov|mp4|pdf|png|svg|tar|tif|tiff|txt|webp|zip)(?:$|[?#\s'")])/i;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_NAME_MAX_LENGTH = 80;

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

export function logMissingAttachmentBlobKey(input: {
    attachmentCount?: number;
    sessionId?: string;
}): void {
    const metadata = createAttachmentUploadLogMetadata({
        phase: 'missing_blob_key',
        attachmentCount: input.attachmentCount,
        sessionId: input.sessionId,
    });
    console.error(formatAttachmentUploadLogMessage(metadata), metadata);
}

export function logAttachmentUploadFailure(input: {
    attachmentIndex?: number;
    attachment?: AttachmentLike;
    error?: unknown;
    sessionId?: string;
    uploadRef?: string;
}): void {
    const metadata = createAttachmentUploadLogMetadata({
        phase: 'upload_failed',
        attachmentIndex: input.attachmentIndex,
        attachment: input.attachment,
        error: input.error,
        sessionId: input.sessionId,
        uploadRef: input.uploadRef,
    });
    console.error(formatAttachmentUploadLogMessage(metadata), metadata);
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

    const trimmed = name.trim();
    if (!trimmed || isSuspiciousErrorName(trimmed)) {
        return 'UnknownError';
    }

    const normalized = name
        .replace(/[^A-Za-z0-9_.:-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, ERROR_NAME_MAX_LENGTH)
        .replace(/^_+|_+$/g, '');

    if (!normalized || !SAFE_ERROR_NAME_PATTERN.test(normalized) || isSuspiciousErrorName(normalized)) {
        return 'UnknownError';
    }

    return normalized || 'UnknownError';
}

function isSuspiciousErrorName(name: string): boolean {
    const slashCount = (name.match(/[\\/]/g) ?? []).length;
    const wordCount = name.trim().split(/\s+/).filter(Boolean).length;

    return TOKEN_LIKE_PATTERN.test(name)
        || URL_LIKE_PATTERN.test(name)
        || UNIX_PATH_PATTERN.test(name)
        || WINDOWS_PATH_PATTERN.test(name)
        || FILENAME_PATTERN.test(name)
        || slashCount >= 2
        || wordCount > 3;
}
