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
const UUID_LIKE_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{24,}$/;
const CLASS_LIKE_SLASH_LABEL_PATTERN = /^[A-Z][A-Za-z0-9_.:-]*(?: [A-Z][A-Za-z0-9_.:-]*){0,3}\/[A-Z][A-Za-z0-9_.:-]*(?: [A-Z][A-Za-z0-9_.:-]*){0,3}$/;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_NAME_MAX_LENGTH = 80;
const PRIVATE_TOKEN_SUBSTRING_MIN_LENGTH = 4;

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
        metadata.errorName = normalizeErrorName(getErrorName(input.error), input);
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

function normalizeErrorName(
    name: unknown,
    privacyContext: {
        attachment?: AttachmentLike;
        sessionId?: string;
        uploadRef?: string;
    },
): string {
    if (typeof name !== 'string') {
        return 'UnknownError';
    }

    const trimmed = name.trim();
    if (!trimmed || isSuspiciousErrorName(trimmed) || matchesPrivateContext(trimmed, privacyContext)) {
        return 'UnknownError';
    }

    const normalized = name
        .replace(/[^A-Za-z0-9_.:-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, ERROR_NAME_MAX_LENGTH)
        .replace(/^_+|_+$/g, '');

    if (
        !normalized
        || !SAFE_ERROR_NAME_PATTERN.test(normalized)
        || isSuspiciousErrorName(normalized)
        || matchesPrivateContext(normalized, privacyContext)
    ) {
        return 'UnknownError';
    }

    return normalized || 'UnknownError';
}

function isSuspiciousErrorName(name: string): boolean {
    const slashCount = (name.match(/[\\/]/g) ?? []).length;
    const wordCount = name.trim().split(/\s+/).filter(Boolean).length;
    const hasPathSeparator = /[\\/]/.test(name);

    return TOKEN_LIKE_PATTERN.test(name)
        || URL_LIKE_PATTERN.test(name)
        || UNIX_PATH_PATTERN.test(name)
        || WINDOWS_PATH_PATTERN.test(name)
        || FILENAME_PATTERN.test(name)
        || UUID_LIKE_PATTERN.test(name)
        || OPAQUE_ID_PATTERN.test(name)
        || (hasPathSeparator && !CLASS_LIKE_SLASH_LABEL_PATTERN.test(name))
        || slashCount >= 2
        || wordCount > 3;
}

function matchesPrivateContext(
    name: string,
    privacyContext: {
        attachment?: AttachmentLike;
        sessionId?: string;
        uploadRef?: string;
    },
): boolean {
    const haystacks = comparableForms(name);

    for (const token of privateContextTokens(privacyContext)) {
        const tokenForms = comparableForms(token);
        if (tokenForms.some((tokenForm) => haystacks.includes(tokenForm))) {
            return true;
        }
        if (token.length >= PRIVATE_TOKEN_SUBSTRING_MIN_LENGTH
            && tokenForms.some((tokenForm) => haystacks.some((haystack) => haystack.includes(tokenForm)))) {
            return true;
        }
    }

    return false;
}

function privateContextTokens(privacyContext: {
    attachment?: AttachmentLike;
    sessionId?: string;
    uploadRef?: string;
}): string[] {
    const tokens = new Set<string>();

    addPrivateToken(tokens, privacyContext.sessionId);
    addPrivateToken(tokens, privacyContext.uploadRef);
    addNameTokens(tokens, privacyContext.attachment?.name);
    addUriTokens(tokens, privacyContext.attachment?.uri);

    return Array.from(tokens);
}

function addNameTokens(tokens: Set<string>, name: unknown): void {
    if (typeof name !== 'string') {
        return;
    }

    addPrivateToken(tokens, name);
    addPrivateToken(tokens, stripExtension(name));
}

function addUriTokens(tokens: Set<string>, uri: unknown): void {
    if (typeof uri !== 'string') {
        return;
    }

    const withoutQuery = uri.split(/[?#]/, 1)[0];
    const withoutScheme = withoutQuery
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '');

    for (const part of withoutScheme.split(/[\\/]+/)) {
        addNameTokens(tokens, part);
    }
}

function addPrivateToken(tokens: Set<string>, token: unknown): void {
    if (typeof token !== 'string') {
        return;
    }

    const trimmed = token.trim();
    if (trimmed.length > 0) {
        tokens.add(trimmed);
    }
}

function stripExtension(value: string): string {
    return value.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

function comparableForms(value: string): string[] {
    const lower = value.toLowerCase();
    const normalized = lower
        .replace(/[^a-z0-9_.:-]/g, '_')
        .replace(/^_+|_+$/g, '');
    const compact = lower.replace(/[^a-z0-9]/g, '');

    return Array.from(new Set([lower, normalized, compact].filter(Boolean)));
}
