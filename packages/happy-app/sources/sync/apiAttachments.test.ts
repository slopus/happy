import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthCredentials } from '@/auth/tokenStorage';
import {
    downloadEncryptedAttachment,
    requestAttachmentUpload,
    uploadEncryptedBlob,
} from './apiAttachments';
import { getAttachmentDiagnostic } from './attachmentDiagnostics';

const { appendFormFile, cleanupFormFile } = vi.hoisted(() => ({
    appendFormFile: vi.fn(),
    cleanupFormFile: vi.fn(),
}));

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.cluster-fluster.com',
}));

vi.mock('./uploadFormFile', () => ({
    appendFormFile,
}));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

const storageUrl = 'https://files.cluster-fluster.com/happy/session-1/ref?X-Amz-Signature=s3-secret&policy=secret-policy';
const apiBlobUrl = 'https://api.cluster-fluster.com/v1/sessions/session-1/attachments/blob?X-Amz-Signature=s3-secret';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cleanupFormFile.mockReset();
    cleanupFormFile.mockResolvedValue(undefined);
    appendFormFile.mockReset();
    appendFormFile.mockResolvedValue(cleanupFormFile);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('requestAttachmentUpload', () => {
    it('classifies request-upload HTTP failures against the Happy API host', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload failed: 500');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 500,
            statusText: 'Internal Server Error',
        });
    });

    it('keeps the request-upload 413 message while adding a diagnostic', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 413,
            statusText: 'Payload Too Large',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            11 * 1024 * 1024,
        ));

        expect(error.message).toBe('Attachment too large (max 10MB)');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 413,
            statusText: 'Payload Too Large',
        });
    });

    it('classifies request-upload network failures against the Happy API host', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
    });

    it('classifies request-upload response parse failures without leaking credentials or refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Unexpected token at ${apiBlobUrl} Bearer ${credentials.token} ref happy/session-1/ref`),
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toContain('request-upload response parse error');
        expect(error.message).toContain('Unexpected token');
        expect(error.message).toContain('[url:api.cluster-fluster.com]');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: expect.stringContaining('Unexpected token'),
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('uploadEncryptedBlob', () => {
    it('classifies POST blob upload network failures without leaking presigned data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies POST blob upload HTTP failures without leaking presigned query data', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        }));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies PUT blob upload network failures on the Happy API host without leaking query data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: apiBlobUrl,
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (PUT) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'PUT',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('downloadEncryptedAttachment', () => {
    it('classifies request-download network failures without leaking attachment refs', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download HTTP failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download failed: 404');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            status: 404,
            statusText: 'Not Found',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download response parse failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Invalid JSON for ref happy/session-1/ref at ${apiBlobUrl}`),
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('request-download response parse error');
        expect(error.message).toContain('Invalid JSON');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'api.cluster-fluster.com',
            target: 'happy-api',
            message: expect.stringContaining('Invalid JSON'),
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download network failures without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download HTTP failures without leaking presigned query data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download body read failures against storage without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: true,
                arrayBufferError: new Error(`stream reset for ${storageUrl} ref happy/session-1/ref`),
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('Attachment download body read error');
        expect(error.message).toContain('stream reset');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: expect.stringContaining('stream reset'),
        });
        expectNoAttachmentLeaks(error);
    });
});

function response(init: {
    ok: boolean;
    status?: number;
    statusText?: string;
    json?: unknown;
    jsonError?: unknown;
    arrayBuffer?: ArrayBuffer;
    arrayBufferError?: unknown;
}): Response {
    return {
        ok: init.ok,
        status: init.status ?? (init.ok ? 200 : 500),
        statusText: init.statusText ?? '',
        json: init.jsonError !== undefined
            ? vi.fn().mockRejectedValue(init.jsonError)
            : vi.fn().mockResolvedValue(init.json),
        arrayBuffer: init.arrayBufferError !== undefined
            ? vi.fn().mockRejectedValue(init.arrayBufferError)
            : vi.fn().mockResolvedValue(init.arrayBuffer ?? new Uint8Array().buffer),
    } as unknown as Response;
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return err as Error;
    }
    throw new Error('Expected promise to reject');
}

function expectNoAttachmentLeaks(error: Error): void {
    const serialized = JSON.stringify({
        message: error.message,
        diagnostic: getAttachmentDiagnostic(error),
    });

    expect(serialized).not.toContain(credentials.token);
    expect(serialized).not.toContain(`Bearer ${credentials.token}`);
    expect(serialized).not.toContain(storageUrl);
    expect(serialized).not.toContain(apiBlobUrl);
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('s3-secret');
    expect(serialized).not.toContain('secret-policy');
    expect(serialized).not.toContain('happy/session-1/ref');
    expect(serialized).not.toContain('/happy/session-1/ref');
}
