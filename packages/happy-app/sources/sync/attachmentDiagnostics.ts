export type AttachmentDiagnosticLeg =
    | 'request-upload'
    | 'blob-upload'
    | 'request-download'
    | 'blob-download'
    | 'decrypt-render';

export type AttachmentTransferTarget = 'happy-api' | 'external-storage' | 'unknown';

export type AttachmentDiagnosticMethod = 'GET' | 'POST' | 'PUT';

export type AttachmentDiagnostic = {
    leg: AttachmentDiagnosticLeg;
    method?: AttachmentDiagnosticMethod;
    host?: string;
    target?: AttachmentTransferTarget;
    status?: number;
    statusText?: string;
    message?: string;
    reason?: string;
};

export type AttachmentDiagnosticRuntimeContext = {
    platform?: string;
    client?: string;
};

const ATTACHMENT_DIAGNOSTIC_ERROR_BRAND: unique symbol = Symbol('happy.attachment-diagnostic-error');

const attachmentDiagnosticLegs = new Set<AttachmentDiagnosticLeg>([
    'request-upload',
    'blob-upload',
    'request-download',
    'blob-download',
    'decrypt-render',
]);

const attachmentDiagnosticMethods = new Set<AttachmentDiagnosticMethod>([
    'GET',
    'POST',
    'PUT',
]);

const attachmentTransferTargets = new Set<AttachmentTransferTarget>([
    'happy-api',
    'external-storage',
    'unknown',
]);

type ResponseLike = {
    status?: number;
    statusText?: string;
};

export type CreateAttachmentDiagnosticInput = {
    leg: AttachmentDiagnosticLeg;
    method?: AttachmentDiagnosticMethod;
    url?: string | null;
    serverUrl?: string;
    response?: ResponseLike;
    message?: string;
    reason?: string;
};

export class AttachmentDiagnosticError extends Error {
    readonly diagnostic: AttachmentDiagnostic;
    readonly [ATTACHMENT_DIAGNOSTIC_ERROR_BRAND] = true;

    constructor(message: string, diagnostic: AttachmentDiagnostic) {
        super(sanitizeDiagnosticText(message) ?? '');
        this.name = 'AttachmentDiagnosticError';
        Object.setPrototypeOf(this, AttachmentDiagnosticError.prototype);
        this.diagnostic = Object.freeze(sanitizeAttachmentDiagnostic(diagnostic));
    }
}

export function sanitizeAttachmentUrlHost(url: string | null | undefined): string | undefined {
    if (!url) return undefined;

    try {
        return new URL(url).host || undefined;
    } catch {
        return undefined;
    }
}

export function classifyAttachmentTransferTarget(
    url: string | null | undefined,
    serverUrl: string | null | undefined,
): AttachmentTransferTarget {
    const host = sanitizeAttachmentUrlHost(url);
    const serverHost = sanitizeAttachmentUrlHost(serverUrl);

    if (!host || !serverHost) {
        return 'unknown';
    }
    return host === serverHost ? 'happy-api' : 'external-storage';
}

export function errorMessageFromUnknown(error: unknown): string {
    return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) ?? '';
}

export function createAttachmentDiagnostic(input: CreateAttachmentDiagnosticInput): AttachmentDiagnostic {
    const host = sanitizeDiagnosticHost(input.url ?? undefined);
    const target = input.url || input.serverUrl
        ? classifyAttachmentTransferTarget(input.url, input.serverUrl)
        : undefined;

    return withoutUndefined({
        leg: input.leg,
        method: input.method,
        host,
        target,
        status: input.response?.status,
        statusText: sanitizeDiagnosticText(input.response?.statusText),
        message: sanitizeDiagnosticText(input.message),
        reason: sanitizeDiagnosticText(input.reason),
    });
}

export function createAttachmentDiagnosticError(
    message: string,
    input: CreateAttachmentDiagnosticInput,
): AttachmentDiagnosticError {
    return new AttachmentDiagnosticError(message, createAttachmentDiagnostic(input));
}

export function getAttachmentDiagnostic(error: unknown): AttachmentDiagnostic | null {
    if (error instanceof AttachmentDiagnosticError) {
        return sanitizeAttachmentDiagnostic(error.diagnostic);
    }

    if (isBrandedAttachmentDiagnosticError(error) && isAttachmentDiagnostic(error.diagnostic)) {
        return sanitizeAttachmentDiagnostic(error.diagnostic);
    }
    return null;
}

export function formatAttachmentDiagnosticForLog(
    diagnostic: AttachmentDiagnostic,
    runtime: AttachmentDiagnosticRuntimeContext = {},
): AttachmentDiagnostic & AttachmentDiagnosticRuntimeContext {
    const sanitized = sanitizeAttachmentDiagnostic(diagnostic);
    return withoutUndefined({
        ...sanitized,
        platform: sanitizeDiagnosticText(runtime.platform),
        client: sanitizeDiagnosticText(runtime.client),
    });
}

function sanitizeAttachmentDiagnostic(diagnostic: AttachmentDiagnostic): AttachmentDiagnostic {
    const sanitized = withoutUndefined({
        leg: attachmentDiagnosticLegs.has(diagnostic.leg) ? diagnostic.leg : undefined,
        method: diagnostic.method === undefined || attachmentDiagnosticMethods.has(diagnostic.method)
            ? diagnostic.method
            : undefined,
        host: sanitizeDiagnosticHost(diagnostic.host),
        target: diagnostic.target === undefined || attachmentTransferTargets.has(diagnostic.target)
            ? diagnostic.target
            : undefined,
        status: typeof diagnostic.status === 'number' ? diagnostic.status : undefined,
        statusText: sanitizeDiagnosticText(diagnostic.statusText),
        message: sanitizeDiagnosticText(diagnostic.message),
        reason: sanitizeDiagnosticText(diagnostic.reason),
    });
    return sanitized as AttachmentDiagnostic;
}

function sanitizeDiagnosticHost(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    const parsedHost = sanitizeAttachmentUrlHost(trimmed);
    if (parsedHost) {
        return isSafeDiagnosticHost(parsedHost) ? parsedHost : undefined;
    }

    if (isSafeDiagnosticHost(trimmed)) {
        return trimmed;
    }

    if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(trimmed)) {
        return undefined;
    }

    return undefined;
}

function isSafeDiagnosticHost(value: string): boolean {
    return !value.includes('\\')
        && !value.includes('@')
        && !/[=&]/.test(value)
        && /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+)(?::\d+)?$/.test(value);
}

function sanitizeDiagnosticText(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    return value
        .replace(/\bdata:[\s\S]*/gi, '[data-uri]')
        .replace(/\bfile:\/\/.*/gi, '[local-file]')
        .replace(/(^|[\s(["'=])[A-Za-z]:\/[^"')\],}]+/g, '$1[local-file]')
        .replace(/(^|[\s(["'=])[A-Za-z]:\\[^"')\],}]+/g, '$1[local-file]')
        .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, (url) => {
            try {
                const parsed = new URL(url);
                if (parsed.protocol === 'file:') {
                    return '[local-file]';
                }
                return parsed.host ? `[url:${parsed.host}]` : '[url]';
            } catch {
                return '[url]';
            }
        })
        .replace(/(^|[^\w.+\-\[])([A-Za-z][A-Za-z0-9+.-]*):[^\s"'<>]+/g, (_url, prefix: string, scheme: string) => `${prefix}[url:${scheme.toLowerCase()}]`)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted-token]')
        .replace(/\bref(?:\s*[=:]\s*|\s+)\/?[A-Za-z0-9._~@-]+(?:\/[A-Za-z0-9._~@-]+)+(?:\?[^\s"'<>]*)?/gi, 'ref=[attachment-ref]')
        .replace(/\b(?:X-Amz-[A-Za-z0-9-]+|AWSAccessKeyId|policy|token|access_token|signature)=[^\s"'<>]+/gi, '[redacted-query]')
        .replace(/(^|[\s(["'=])\/(?:Users|home|var|tmp|private|Volumes|data\/user\/0|data\/data|storage\/emulated\/0|sdcard)\/[^"')\],}]+/g, '$1[local-file]')
        .replace(/(^|[\s(["'])\/?(?:happy|sessions)\/[A-Za-z0-9._~@-]+(?:\/[A-Za-z0-9._~@-]+)+(?:\?[^\s"'<>]*)?/gi, '$1[attachment-ref]');
}

function isBrandedAttachmentDiagnosticError(value: unknown): value is {
    [ATTACHMENT_DIAGNOSTIC_ERROR_BRAND]: true;
    diagnostic: unknown;
} {
    return isRecord(value)
        && value[ATTACHMENT_DIAGNOSTIC_ERROR_BRAND] === true;
}

function isAttachmentDiagnostic(value: unknown): value is AttachmentDiagnostic {
    if (!isRecord(value) || !attachmentDiagnosticLegs.has(value.leg as AttachmentDiagnosticLeg)) {
        return false;
    }

    return (value.method === undefined || attachmentDiagnosticMethods.has(value.method as AttachmentDiagnosticMethod))
        && (value.host === undefined || typeof value.host === 'string')
        && (value.target === undefined || attachmentTransferTargets.has(value.target as AttachmentTransferTarget))
        && (value.status === undefined || typeof value.status === 'number')
        && (value.statusText === undefined || typeof value.statusText === 'string')
        && (value.message === undefined || typeof value.message === 'string')
        && (value.reason === undefined || typeof value.reason === 'string');
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry;
        }
    }
    return result as T;
}
