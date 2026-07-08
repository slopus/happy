# Attachment Storage Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe attachment upload/download diagnostics that identify the failing storage leg without leaking presigned URLs, refs, tokens, local file paths, or attachment bytes.

**Architecture:** Add one pure diagnostics module under `packages/happy-app/sources/sync` and route attachment API failures through it. Keep the current direct-to-storage transfer behavior unchanged, then update upload/download render logs to print the structured diagnostic payload instead of full transfer URLs.

**Tech Stack:** TypeScript, Vitest, React Native/Expo, Happy encrypted attachment APIs, browser/native `fetch`, S3 presigned POST/GET.

---

## File Structure

- Create `packages/happy-app/sources/sync/attachmentDiagnostics.ts`: typed diagnostic model, safe URL host extraction, transfer-target classification, diagnostic error wrapper, and log serialization.
- Create `packages/happy-app/sources/sync/attachmentDiagnostics.test.ts`: pure unit tests for sanitization, target classification, safe serialization, and diagnostic error extraction.
- Create `packages/happy-app/sources/sync/apiAttachments.test.ts`: unit tests for upload/download API wrappers and blob transfer failure classification.
- Modify `packages/happy-app/sources/sync/apiAttachments.ts`: wrap request-upload, blob-upload, request-download, and blob-download failures in `AttachmentDiagnosticError` without changing successful transfer behavior.
- Modify `packages/happy-app/sources/sync/sync.ts`: log upload failures with safe diagnostic payloads and stop logging attachment filenames or raw Error objects for diagnostic-aware failures.
- Modify `packages/happy-app/sources/hooks/useAttachmentImage.ts`: log download and decrypt/render failures with the same safe diagnostic format.

### Task 1: Diagnostic Model

**Files:**
- Create: `packages/happy-app/sources/sync/attachmentDiagnostics.ts`
- Create: `packages/happy-app/sources/sync/attachmentDiagnostics.test.ts`

- [ ] **Step 1: Write the failing diagnostics tests**

Create `packages/happy-app/sources/sync/attachmentDiagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    AttachmentDiagnosticError,
    classifyAttachmentTransferTarget,
    createAttachmentDiagnostic,
    createAttachmentDiagnosticError,
    formatAttachmentDiagnosticForLog,
    getAttachmentDiagnostic,
    sanitizeAttachmentUrlHost,
} from './attachmentDiagnostics';

describe('sanitizeAttachmentUrlHost', () => {
    it('keeps only the host and port from absolute URLs', () => {
        expect(sanitizeAttachmentUrlHost('https://files.cluster-fluster.com/happy/sessions/ref?X-Amz-Signature=secret'))
            .toBe('files.cluster-fluster.com');
        expect(sanitizeAttachmentUrlHost('http://127.0.0.1:3005/v1/sessions/abc?token=secret'))
            .toBe('127.0.0.1:3005');
    });

    it('returns undefined for missing or unparsable URLs', () => {
        expect(sanitizeAttachmentUrlHost(undefined)).toBeUndefined();
        expect(sanitizeAttachmentUrlHost(null)).toBeUndefined();
        expect(sanitizeAttachmentUrlHost('/relative/path?token=secret')).toBeUndefined();
        expect(sanitizeAttachmentUrlHost('not a url with /slashes?token=secret')).toBeUndefined();
    });
});

describe('classifyAttachmentTransferTarget', () => {
    it('classifies URLs on the Happy API host as happy-api', () => {
        expect(classifyAttachmentTransferTarget(
            'https://api.cluster-fluster.com/v1/sessions/abc/attachments/blob',
            'https://api.cluster-fluster.com',
        )).toBe('happy-api');
    });

    it('classifies other valid hosts as external-storage', () => {
        expect(classifyAttachmentTransferTarget(
            'https://files.cluster-fluster.com/happy/abc?policy=secret',
            'https://api.cluster-fluster.com',
        )).toBe('external-storage');
    });

    it('classifies invalid URLs as unknown', () => {
        expect(classifyAttachmentTransferTarget(
            '/v1/sessions/abc/attachments/blob',
            'https://api.cluster-fluster.com',
        )).toBe('unknown');
    });
});

describe('attachment diagnostic serialization', () => {
    it('builds a safe diagnostic from a response', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'blob-upload',
            method: 'POST',
            url: 'https://files.cluster-fluster.com/happy/sessions/ref?X-Amz-Signature=secret&policy=secret',
            serverUrl: 'https://api.cluster-fluster.com',
            response: {
                status: 403,
                statusText: 'Forbidden',
            },
        });

        expect(diagnostic).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });

        const rendered = formatAttachmentDiagnosticForLog(diagnostic, {
            platform: 'web',
            client: 'web/1.2.3',
        });
        const serialized = JSON.stringify(rendered);

        expect(serialized).toContain('"leg":"blob-upload"');
        expect(serialized).toContain('"host":"files.cluster-fluster.com"');
        expect(serialized).toContain('"platform":"web"');
        expect(serialized).toContain('"client":"web/1.2.3"');
        expect(serialized).not.toContain('/happy/sessions/ref');
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('policy');
        expect(serialized).not.toContain('secret');
    });

    it('keeps network messages but not source URLs', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'blob-download',
            method: 'GET',
            url: 'https://files.cluster-fluster.com/happy/sessions/ref?AWSAccessKeyId=secret',
            serverUrl: 'https://api.cluster-fluster.com',
            message: 'Failed to fetch',
        });

        expect(diagnostic).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
    });
});

describe('AttachmentDiagnosticError', () => {
    it('wraps and extracts diagnostics from thrown errors', () => {
        const error = createAttachmentDiagnosticError('Blob upload (POST) failed: 403 Forbidden', {
            leg: 'blob-upload',
            method: 'POST',
            url: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            serverUrl: 'https://api.cluster-fluster.com',
            response: {
                status: 403,
                statusText: 'Forbidden',
            },
        });

        expect(error).toBeInstanceOf(AttachmentDiagnosticError);
        expect(error.message).toBe('Blob upload (POST) failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });

        const serialized = `${error.message} ${JSON.stringify(error.diagnostic)}`;
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('/happy/ref');
    });

    it('returns null for ordinary errors', () => {
        expect(getAttachmentDiagnostic(new Error('plain failure'))).toBeNull();
        expect(getAttachmentDiagnostic('plain failure')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the failing diagnostics tests**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts
```

Expected: FAIL with an import error because `attachmentDiagnostics.ts` does not exist.

- [ ] **Step 3: Add the diagnostics module**

Create `packages/happy-app/sources/sync/attachmentDiagnostics.ts`:

```ts
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

    constructor(message: string, diagnostic: AttachmentDiagnostic) {
        super(message);
        this.name = 'AttachmentDiagnosticError';
        this.diagnostic = diagnostic;
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
    return error instanceof Error ? error.message : String(error);
}

export function createAttachmentDiagnostic(input: CreateAttachmentDiagnosticInput): AttachmentDiagnostic {
    const host = sanitizeAttachmentUrlHost(input.url);
    const target = input.url || input.serverUrl
        ? classifyAttachmentTransferTarget(input.url, input.serverUrl)
        : undefined;

    return withoutUndefined({
        leg: input.leg,
        method: input.method,
        host,
        target,
        status: input.response?.status,
        statusText: input.response?.statusText,
        message: input.message,
        reason: input.reason,
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
        return error.diagnostic;
    }
    return null;
}

export function formatAttachmentDiagnosticForLog(
    diagnostic: AttachmentDiagnostic,
    runtime: AttachmentDiagnosticRuntimeContext = {},
): AttachmentDiagnostic & AttachmentDiagnosticRuntimeContext {
    return withoutUndefined({
        ...diagnostic,
        platform: runtime.platform,
        client: runtime.client,
    });
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
```

- [ ] **Step 4: Run diagnostics tests and commit**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/happy-app/sources/sync/attachmentDiagnostics.ts packages/happy-app/sources/sync/attachmentDiagnostics.test.ts
git commit -m "test: add attachment diagnostics model"
```

### Task 2: API Attachment Failure Classification

**Files:**
- Create: `packages/happy-app/sources/sync/apiAttachments.test.ts`
- Modify: `packages/happy-app/sources/sync/apiAttachments.ts`

- [ ] **Step 1: Write failing API attachment diagnostics tests**

Create `packages/happy-app/sources/sync/apiAttachments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAttachmentDiagnostic } from './attachmentDiagnostics';
import {
    downloadEncryptedAttachment,
    requestAttachmentUpload,
    uploadEncryptedBlob,
} from './apiAttachments';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.cluster-fluster.com',
}));

const { appendFormFileMock } = vi.hoisted(() => ({
    appendFormFileMock: vi.fn(async (
        formData: FormData,
        bytes: Uint8Array,
        field: string,
        filename: string,
        contentType: string,
    ) => {
        formData.append(field, new Blob([new Uint8Array(bytes).buffer], { type: contentType }), filename);
        return vi.fn(async () => undefined);
    }),
}));

vi.mock('./uploadFormFile', () => ({
    appendFormFile: appendFormFileMock,
}));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

function response(init: {
    ok: boolean;
    status: number;
    statusText?: string;
    json?: unknown;
    arrayBuffer?: ArrayBuffer;
}) {
    return {
        ok: init.ok,
        status: init.status,
        statusText: init.statusText === undefined ? '' : init.statusText,
        json: vi.fn().mockResolvedValue(init.json),
        arrayBuffer: vi.fn().mockResolvedValue(init.arrayBuffer === undefined ? new Uint8Array([1, 2, 3]).buffer : init.arrayBuffer),
    };
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
    try {
        await action();
    } catch (error) {
        return error;
    }
    throw new Error('Expected action to throw');
}

function serializedError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name} ${error.message} ${JSON.stringify(getAttachmentDiagnostic(error))}`;
    }
    return String(error);
}

describe('api attachment diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('classifies request-upload HTTP failures', async () => {
        vi.mocked(global.fetch).mockResolvedValue(response({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        }) as Response);

        const error = await captureError(() => requestAttachmentUpload(
            credentials,
            'session-1',
            'image.png',
            123,
        ));

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('request-upload failed: 500');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 500,
            statusText: 'Internal Server Error',
        });
        expect(serializedError(error)).not.toContain('test-token');
    });

    it('keeps the existing too-large message while adding a request-upload diagnostic', async () => {
        vi.mocked(global.fetch).mockResolvedValue(response({
            ok: false,
            status: 413,
            statusText: 'Payload Too Large',
        }) as Response);

        const error = await captureError(() => requestAttachmentUpload(
            credentials,
            'session-1',
            'image.png',
            11 * 1024 * 1024,
        ));

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Attachment too large (max 10MB)');
        expect(getAttachmentDiagnostic(error)).toMatchObject({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 413,
        });
    });

    it('classifies POST blob upload network failures without leaking presigned URL data', async () => {
        vi.mocked(global.fetch).mockRejectedValue(new Error('Failed to fetch'));

        const error = await captureError(() => uploadEncryptedBlob({
            method: 'POST',
            uploadUrl: 'https://files.cluster-fluster.com/happy/session-1/ref?X-Amz-Signature=secret&policy=secret',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Blob upload (POST) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });

        const serialized = serializedError(error);
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('secret-policy');
        expect(serialized).not.toContain('/happy/session-1/ref');
    });

    it('classifies POST blob upload HTTP failures', async () => {
        vi.mocked(global.fetch).mockResolvedValue(response({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        }) as Response);

        const error = await captureError(() => uploadEncryptedBlob({
            method: 'POST',
            uploadUrl: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Credential=secret',
            formFields: { key: 'happy/ref' },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect((error as Error).message).toBe('Blob upload (POST) failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expect(serializedError(error)).not.toContain('X-Amz-Credential');
    });

    it('classifies PUT blob upload network failures on the Happy API host', async () => {
        vi.mocked(global.fetch).mockRejectedValue(new Error('Network request failed'));

        const error = await captureError(() => uploadEncryptedBlob({
            method: 'PUT',
            uploadUrl: 'https://api.cluster-fluster.com/v1/sessions/session-1/attachments/blob/ref?token=secret',
        }, new Uint8Array([1, 2, 3]), credentials));

        expect((error as Error).message).toBe('Blob upload (PUT) network error: Network request failed');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'PUT',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Network request failed',
        });
        expect(serializedError(error)).not.toContain('token=secret');
    });

    it('classifies request-download HTTP failures', async () => {
        vi.mocked(global.fetch).mockResolvedValue(response({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }) as Response);

        const error = await captureError(() => downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect((error as Error).message).toBe('request-download failed: 404');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 404,
            statusText: 'Not Found',
        });
        expect(serializedError(error)).not.toContain('happy/session-1/ref');
    });

    it('classifies blob-download network failures without leaking presigned URL data', async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(response({
                ok: true,
                status: 200,
                json: {
                    downloadUrl: 'https://files.cluster-fluster.com/happy/session-1/ref?X-Amz-Signature=secret',
                },
            }) as Response)
            .mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await captureError(() => downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect((error as Error).message).toBe('Attachment download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expect(serializedError(error)).not.toContain('X-Amz-Signature');
        expect(serializedError(error)).not.toContain('/happy/session-1/ref');
    });

    it('classifies blob-download HTTP failures', async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(response({
                ok: true,
                status: 200,
                json: {
                    downloadUrl: 'https://files.cluster-fluster.com/happy/ref?AWSAccessKeyId=secret',
                },
            }) as Response)
            .mockResolvedValueOnce(response({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
            }) as Response);

        const error = await captureError(() => downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect((error as Error).message).toBe('Attachment download failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expect(serializedError(error)).not.toContain('AWSAccessKeyId');
    });
});
```

- [ ] **Step 2: Run the failing API attachment tests**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/apiAttachments.test.ts
```

Expected: FAIL because `apiAttachments.ts` still throws ordinary `Error` objects and includes full transfer URLs in blob-upload/download messages.

- [ ] **Step 3: Import diagnostics in `apiAttachments.ts`**

In `packages/happy-app/sources/sync/apiAttachments.ts`, add:

```ts
import {
    createAttachmentDiagnosticError,
    errorMessageFromUnknown,
} from './attachmentDiagnostics';
```

- [ ] **Step 4: Wrap request-upload failures**

In `requestAttachmentUpload`, replace the initial `fetch` and non-OK block with:

```ts
    const requestUrl = `${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-upload`;
    let response: Response;
    try {
        response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ filename, size }),
        });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(`request-upload network error: ${message}`, {
            leg: 'request-upload',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }

    if (!response.ok) {
        const diagnosticInput = {
            leg: 'request-upload' as const,
            method: 'POST' as const,
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            response,
        };
        if (response.status === 413) {
            throw createAttachmentDiagnosticError(`Attachment too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`, diagnosticInput);
        }
        if (response.status === 404) {
            throw createAttachmentDiagnosticError('Session not found', diagnosticInput);
        }
        throw createAttachmentDiagnosticError(`request-upload failed: ${response.status}`, diagnosticInput);
    }
```

- [ ] **Step 5: Wrap POST blob-upload failures**

In `uploadEncryptedBlob`, replace the `if (upload.method === 'POST')` block with:

```ts
    const serverUrl = getServerUrl();

    if (upload.method === 'POST') {
        const formData = new FormData();
        if (upload.formFields) {
            for (const [k, v] of Object.entries(upload.formFields)) {
                formData.append(k, v);
            }
        }
        let cleanup: (() => Promise<void>) | undefined;
        let response: Response;
        try {
            cleanup = await appendFormFile(formData, encryptedData, 'file', 'blob', 'application/octet-stream');
            response = await fetch(upload.uploadUrl, {
                method: 'POST',
                body: formData,
            });
        } catch (err) {
            if (cleanup) {
                await cleanup();
            }
            const message = errorMessageFromUnknown(err);
            throw createAttachmentDiagnosticError(`Blob upload (POST) network error: ${message}`, {
                leg: 'blob-upload',
                method: 'POST',
                url: upload.uploadUrl,
                serverUrl,
                message,
            });
        }
        await cleanup();
        if (!response.ok) {
            throw createAttachmentDiagnosticError(`Blob upload (POST) failed: ${response.status} ${response.statusText}`, {
                leg: 'blob-upload',
                method: 'POST',
                url: upload.uploadUrl,
                serverUrl,
                response,
            });
        }
        return;
    }
```

- [ ] **Step 6: Wrap PUT blob-upload failures**

In the PUT branch of `uploadEncryptedBlob`, remove the duplicate `const serverUrl = getServerUrl();` line because Step 5 moved it above the POST branch. Replace the PUT `catch` and non-OK block with:

```ts
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(`Blob upload (PUT) network error: ${message}`, {
            leg: 'blob-upload',
            method: 'PUT',
            url: upload.uploadUrl,
            serverUrl,
            message,
        });
    }

    if (!response.ok) {
        throw createAttachmentDiagnosticError(`Blob upload (PUT) failed: ${response.status} ${response.statusText}`, {
            leg: 'blob-upload',
            method: 'PUT',
            url: upload.uploadUrl,
            serverUrl,
            response,
        });
    }
```

- [ ] **Step 7: Wrap request-download and blob-download failures**

In `downloadEncryptedAttachment`, replace the request-download `fetch`, request non-OK block, blob-download `catch`, and blob non-OK block with:

```ts
    const requestUrl = `${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-download`;
    let requestRes: Response;
    try {
        requestRes = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref }),
        });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(`request-download network error: ${message}`, {
            leg: 'request-download',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    if (!requestRes.ok) {
        throw createAttachmentDiagnosticError(`request-download failed: ${requestRes.status}`, {
            leg: 'request-download',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            response: requestRes,
        });
    }
```

Keep the existing JSON parsing and `rewriteLoopbackHost` lines after this block:

```ts
    const { downloadUrl: rawDownloadUrl } = await requestRes.json() as { downloadUrl: string };
    const downloadUrl = rewriteLoopbackHost(rawDownloadUrl);
```

Replace the blob-download `catch` and non-OK block with:

```ts
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(`Attachment download network error: ${message}`, {
            leg: 'blob-download',
            method: 'GET',
            url: downloadUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    if (!blobRes.ok) {
        throw createAttachmentDiagnosticError(`Attachment download failed: ${blobRes.status} ${blobRes.statusText}`, {
            leg: 'blob-download',
            method: 'GET',
            url: downloadUrl,
            serverUrl: API_ENDPOINT,
            response: blobRes,
        });
    }
```

- [ ] **Step 8: Run API attachment tests and commit**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/apiAttachments.test.ts
```

Expected: PASS.

Run the diagnostics test again:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts sources/sync/apiAttachments.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/happy-app/sources/sync/apiAttachments.ts packages/happy-app/sources/sync/apiAttachments.test.ts
git commit -m "fix: classify attachment transfer failures"
```

### Task 3: Upload Failure Logging

**Files:**
- Modify: `packages/happy-app/sources/sync/sync.ts`

- [ ] **Step 1: Add diagnostic logging imports**

In `packages/happy-app/sources/sync/sync.ts`, add:

```ts
import {
    formatAttachmentDiagnosticForLog,
    getAttachmentDiagnostic,
} from './attachmentDiagnostics';
```

- [ ] **Step 2: Replace upload failure logging**

In `uploadAttachmentsForSession`, replace:

```ts
                console.error(`[attachments] Failed to upload ${attachment.name}:`, err);
```

with:

```ts
                const diagnostic = getAttachmentDiagnostic(err);
                if (diagnostic) {
                    console.error('[attachments] Failed to upload image attachment:', formatAttachmentDiagnosticForLog(diagnostic, {
                        platform: Platform.OS,
                        client: getHappyClientId(),
                    }));
                } else {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error('[attachments] Failed to upload image attachment:', {
                        leg: 'blob-upload',
                        message,
                        platform: Platform.OS,
                        client: getHappyClientId(),
                    });
                }
```

This removes the attachment filename from the failure log and avoids serializing raw `Error` objects that may contain full URLs.

- [ ] **Step 3: Run targeted app tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts sources/sync/apiAttachments.test.ts sources/sync/attachmentSupport.test.ts
```

Expected: PASS.

Run:

```bash
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit upload logging**

Commit:

```bash
git add packages/happy-app/sources/sync/sync.ts
git commit -m "fix: log safe attachment upload diagnostics"
```

### Task 4: Download And Decrypt/Render Logging

**Files:**
- Modify: `packages/happy-app/sources/hooks/useAttachmentImage.ts`

- [ ] **Step 1: Add imports and helper**

In `packages/happy-app/sources/hooks/useAttachmentImage.ts`, add these imports:

```ts
import { Platform } from 'react-native';
import {
    createAttachmentDiagnostic,
    formatAttachmentDiagnosticForLog,
    getAttachmentDiagnostic,
} from '@/sync/attachmentDiagnostics';
```

Below `detectImageMime`, add:

```ts
function warnAttachmentImageDiagnostic(reason: string, message?: string) {
    console.warn('[attachment-image] load failed:', formatAttachmentDiagnosticForLog(createAttachmentDiagnostic({
        leg: 'decrypt-render',
        reason,
        message,
    }), {
        platform: Platform.OS,
    }));
}
```

- [ ] **Step 2: Replace non-download hook warnings with decrypt-render diagnostics**

In `loadAttachmentDataUri`, replace the three early warning blocks:

```ts
        console.warn(`[attachment-image] no credentials for ${ref}`);
```

```ts
        console.warn(`[attachment-image] no blobKey for session ${sessionId} (ref=${ref})`);
```

```ts
        console.warn(`[attachment-image] blobKey wrong length: ${blobKey.length} (ref=${ref})`);
```

with:

```ts
        warnAttachmentImageDiagnostic('no-credentials');
```

```ts
        warnAttachmentImageDiagnostic('missing-blob-key');
```

```ts
        warnAttachmentImageDiagnostic('invalid-blob-key-length', String(blobKey.length));
```

- [ ] **Step 3: Replace download and decrypt warnings**

In the download `catch`, replace:

```ts
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[attachment-image] download failed for ${ref}: ${message}`);
```

with:

```ts
        const diagnostic = getAttachmentDiagnostic(err);
        if (diagnostic) {
            console.warn('[attachment-image] download failed:', formatAttachmentDiagnosticForLog(diagnostic, {
                platform: Platform.OS,
            }));
        } else {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[attachment-image] download failed:', formatAttachmentDiagnosticForLog(createAttachmentDiagnostic({
                leg: 'blob-download',
                message,
            }), {
                platform: Platform.OS,
            }));
        }
```

Replace:

```ts
        console.warn(`[attachment-image] decrypt returned null for ${ref} (encrypted.length=${encrypted.length})`);
```

with:

```ts
        warnAttachmentImageDiagnostic('decrypt-returned-null');
```

- [ ] **Step 4: Run targeted app tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts sources/sync/apiAttachments.test.ts
```

Expected: PASS.

Run:

```bash
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit download/decrypt logging**

Commit:

```bash
git add packages/happy-app/sources/hooks/useAttachmentImage.ts
git commit -m "fix: log safe attachment download diagnostics"
```

### Task 5: Manual Smoke And Final Verification

**Files:**
- No new files.
- Verify behavior in `packages/happy-app`.

- [ ] **Step 1: Run the complete targeted test set**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts sources/sync/apiAttachments.test.ts sources/sync/attachmentSupport.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run app typecheck**

Run:

```bash
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 3: Start the web app for manual testing**

Run:

```bash
pnpm --dir packages/happy-app web:test
```

Expected: Expo starts a web server and prints a local URL.

- [ ] **Step 4: Verify normal image upload**

Open the printed web URL, sign in if required, open a Codex or Claude session, attach a small PNG/JPEG, and send it.

Expected:

- The message sends.
- The image appears inline after the message syncs back.
- Browser console and app logs do not contain `X-Amz-Signature`, `X-Amz-Credential`, `policy`, `AWSAccessKeyId`, `Bearer`, full `files.cluster-fluster.com/happy/...` paths, local file paths, base64 payloads, or attachment refs.

- [ ] **Step 5: Verify blocked storage-host upload diagnostic**

In browser devtools, enable request blocking for:

```text
https://files.cluster-fluster.com/*
```

Send another small image.

Expected:

- Existing upload-failed alert still appears.
- Text still sends when text was present.
- Log line starts with `[attachments] Failed to upload image attachment:`.
- Diagnostic object includes `leg: "blob-upload"`, `host: "files.cluster-fluster.com"`, and `target: "external-storage"`.
- Diagnostic object does not include presigned URL path/query data, form fields, token strings, local file paths, attachment refs, bytes, or base64 payloads.

- [ ] **Step 6: Verify blocked API diagnostic**

Disable the storage-host block. Enable request blocking for:

```text
https://api.cluster-fluster.com/v1/sessions/*/attachments/request-upload
```

Send another small image.

Expected:

- Existing upload-failed alert still appears.
- Log line starts with `[attachments] Failed to upload image attachment:`.
- Diagnostic object includes `leg: "request-upload"`, `host: "api.cluster-fluster.com"`, and `target: "happy-api"`.
- Diagnostic object does not include bearer tokens, session attachment refs, bytes, or local file paths.

- [ ] **Step 7: Verify blocked storage-host download diagnostic**

Disable the API block. Send an image successfully, refresh the page or reopen the session, then block:

```text
https://files.cluster-fluster.com/*
```

Expected:

- Inline image falls back to the existing image error/loading failure state.
- Log line starts with `[attachment-image] download failed:`.
- Diagnostic object includes `leg: "blob-download"`, `host: "files.cluster-fluster.com"`, and `target: "external-storage"`.
- Diagnostic object does not include presigned URL path/query data, attachment refs, bytes, or base64 payloads.

- [ ] **Step 8: Inspect final diff for secret leaks**

Run:

```bash
git diff --check
rg -n "uploadUrl|downloadUrl|X-Amz|AWSAccessKeyId|policy|Bearer|ref=|\\$\\{ref\\}|attachment\\.name" packages/happy-app/sources/sync/apiAttachments.ts packages/happy-app/sources/sync/sync.ts packages/happy-app/sources/hooks/useAttachmentImage.ts packages/happy-app/sources/sync/attachmentDiagnostics.ts
```

Expected:

- `git diff --check` prints no output.
- `rg` may show safe request body fields and form-field handling, but no thrown/logged error strings that include full `uploadUrl`, full `downloadUrl`, `ref`, bearer tokens, or `attachment.name`.

- [ ] **Step 9: Final commit if any manual-test-only changes were needed**

If manual testing required code changes after Task 4, run the targeted tests and typecheck again:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentDiagnostics.test.ts sources/sync/apiAttachments.test.ts sources/sync/attachmentSupport.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS for both commands.

Commit only the changed files:

```bash
git status --short
git add packages/happy-app/sources/sync/attachmentDiagnostics.ts packages/happy-app/sources/sync/attachmentDiagnostics.test.ts packages/happy-app/sources/sync/apiAttachments.ts packages/happy-app/sources/sync/apiAttachments.test.ts packages/happy-app/sources/sync/sync.ts packages/happy-app/sources/hooks/useAttachmentImage.ts
git commit -m "fix: harden attachment storage diagnostics"
```

If there are no code changes after Task 4, do not create an empty commit.

## Self-Review Checklist

- Spec coverage: Task 1 creates the diagnostic model and sanitization boundary; Task 2 classifies `request-upload`, `blob-upload`, `request-download`, and `blob-download`; Tasks 3 and 4 log upload/download/decrypt-render failures; Task 5 verifies normal behavior, blocked storage host, blocked API, and log secrecy.
- User behavior: no task changes successful transfer flow, file event shape, encryption, cache behavior, or upload-failed alerts.
- Privacy: tests assert no presigned query strings, policy data, bearer tokens, refs, local paths, bytes, or base64 payloads are logged by the new diagnostic path.
- Phase 2 fallback: intentionally excluded from this implementation plan until diagnostics show failures concentrated on the external storage host.
