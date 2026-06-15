import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createAttachmentUploadLogMetadata,
    formatAttachmentUploadLogMessage,
    logAttachmentUploadFailure,
    logMissingAttachmentBlobKey,
} from './attachmentUploadLogging';

describe('attachment upload logging', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('formats missing blob key metadata without raw session ids', () => {
        const metadata = createAttachmentUploadLogMetadata({
            phase: 'missing_blob_key',
            attachmentCount: 2,
            sessionId: 'session-secret-123',
        });
        const serialized = JSON.stringify(metadata);

        expect(metadata).toEqual({
            phase: 'missing_blob_key',
            attachmentCount: 2,
        });
        expect(formatAttachmentUploadLogMessage(metadata)).toBe('[attachments] missing_blob_key');
        expect(serialized).not.toContain('session-secret-123');
    });

    it('formats upload failure metadata without raw attachment identifiers or raw error text', () => {
        const error = new Error('failed /Users/devdvlive/private/photo.png with token sk-secret');
        error.name = 'UploadFailed/With Path';
        error.stack = 'UploadFailed: /Users/devdvlive/private/photo.png\n    at secret-stack-line';

        const metadata = createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            attachmentIndex: 3,
            attachment: {
                name: 'private-photo.png',
                uri: 'file:///Users/devdvlive/private/photo.png',
                size: 12345,
                width: 640,
                height: 480,
                mimeType: 'image/png',
            },
            error,
            uploadRef: 'blob-ref-secret',
            sessionId: 'session-secret-456',
        });
        const serialized = JSON.stringify(metadata);

        expect(metadata).toEqual({
            phase: 'upload_failed',
            attachmentIndex: 3,
            size: 12345,
            width: 640,
            height: 480,
            errorName: 'UploadFailed_With_Path',
        });
        expect(formatAttachmentUploadLogMessage(metadata)).toBe('[attachments] upload_failed');
        expect(serialized).not.toContain('private-photo.png');
        expect(serialized).not.toContain('file:///Users/devdvlive/private/photo.png');
        expect(serialized).not.toContain('/Users/devdvlive');
        expect(serialized).not.toContain('image/png');
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('secret-stack-line');
        expect(serialized).not.toContain('blob-ref-secret');
        expect(serialized).not.toContain('session-secret-456');
    });

    it('bounds and normalizes errorName', () => {
        const metadata = createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            error: { name: 'Very Long Error Name With Spaces And Slashes '.repeat(6) },
        });

        expect(metadata.errorName?.length).toBeLessThanOrEqual(80);
        expect(metadata.errorName).toMatch(/^[A-Za-z0-9_.:-]+$/);
    });

    it('falls back for adversarial error names instead of preserving safe-looking secrets', () => {
        const metadata = createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            attachmentIndex: 3,
            attachment: {
                name: 'private-photo.png',
                uri: 'file:///Users/me/private/photo.png',
                size: 12345,
                width: 640,
                height: 480,
                mimeType: 'image/png',
            },
            error: { name: 'sk-secret /Users/me/private/photo.png' },
            uploadRef: 'blob-ref-secret',
            sessionId: 'session-secret-456',
        });
        const serialized = JSON.stringify(metadata);

        expect(metadata).toEqual({
            phase: 'upload_failed',
            attachmentIndex: 3,
            size: 12345,
            width: 640,
            height: 480,
            errorName: 'UnknownError',
        });
        expect(Object.keys(metadata).sort()).toEqual([
            'attachmentIndex',
            'errorName',
            'height',
            'phase',
            'size',
            'width',
        ]);
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('/Users');
        expect(serialized).not.toContain('photo.png');
        expect(serialized).not.toContain('blob-ref-secret');
        expect(serialized).not.toContain('session-secret-456');
    });

    it('falls back for URL and file URI error names', () => {
        for (const name of [
            'https://example.com/private/photo.png?token=secret',
            'file:///Users/me/private/photo.png',
            'C:\\Users\\me\\private\\photo.jpg',
        ]) {
            expect(createAttachmentUploadLogMetadata({
                phase: 'upload_failed',
                error: { name },
            }).errorName).toBe('UnknownError');
        }
    });

    it('falls back for UUID-like and relative-path error names', () => {
        for (const name of [
            '019eb218-2979-7ba0-adfe-4b1625535e92',
            'relative/path',
        ]) {
            expect(createAttachmentUploadLogMetadata({
                phase: 'upload_failed',
                error: { name },
            }).errorName).toBe('UnknownError');
        }
    });

    it('falls back when errorName matches private upload context', () => {
        const sessionId = '019eb218-2979-7ba0-adfe-4b1625535e92';
        const uploadRef = 'blob-ref-secret';
        const attachment = {
            name: 'private-photo',
            uri: 'file:///Users/me/private/photo.png',
            size: 12345,
            width: 640,
            height: 480,
            mimeType: 'image/png',
        };

        for (const name of [
            attachment.name,
            `UploadFailed:${sessionId}`,
            `UploadFailed:${uploadRef}`,
            `UploadFailed:${attachment.name}`,
            'UploadFailed:photo',
            'UploadFailed:photo.png',
        ]) {
            const metadata = createAttachmentUploadLogMetadata({
                phase: 'upload_failed',
                attachment,
                error: { name },
                sessionId,
                uploadRef,
            });
            const serialized = JSON.stringify(metadata);

            expect(metadata.errorName).toBe('UnknownError');
            expect(serialized).not.toContain(sessionId);
            expect(serialized).not.toContain(uploadRef);
            expect(serialized).not.toContain(attachment.name);
            expect(serialized).not.toContain('photo.png');
        }
    });

    it('omits non-finite numbers and non-positive dimensions', () => {
        expect(createAttachmentUploadLogMetadata({
            phase: 'missing_blob_key',
            attachmentCount: Number.POSITIVE_INFINITY,
        })).toEqual({
            phase: 'missing_blob_key',
        });

        expect(createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            attachmentIndex: Number.NaN,
            attachment: {
                size: Number.NEGATIVE_INFINITY,
                width: 0,
                height: -1,
            },
            error: { name: 'TypeError' },
        })).toEqual({
            phase: 'upload_failed',
            errorName: 'TypeError',
        });
    });

    it('logs missing blob key with only safe metadata arguments', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        logMissingAttachmentBlobKey({
            attachmentCount: 2,
            sessionId: 'session-secret-123',
        });

        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith('[attachments] missing_blob_key', {
            phase: 'missing_blob_key',
            attachmentCount: 2,
        });
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('session-secret-123');
    });

    it('logs upload failure with only safe metadata arguments', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        logAttachmentUploadFailure({
            attachmentIndex: 4,
            attachment: {
                name: 'private-photo.png',
                uri: 'file:///Users/me/private/photo.png',
                size: 12345,
                width: 640,
                height: 480,
                mimeType: 'image/png',
            },
            error: { name: 'sk-secret /Users/me/private/photo.png' },
            uploadRef: 'blob-ref-secret',
            sessionId: 'session-secret-456',
        });

        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith('[attachments] upload_failed', {
            phase: 'upload_failed',
            attachmentIndex: 4,
            size: 12345,
            width: 640,
            height: 480,
            errorName: 'UnknownError',
        });

        const serializedCalls = JSON.stringify(consoleError.mock.calls);
        expect(serializedCalls).not.toContain('private-photo.png');
        expect(serializedCalls).not.toContain('file:///Users/me/private/photo.png');
        expect(serializedCalls).not.toContain('/Users');
        expect(serializedCalls).not.toContain('image/png');
        expect(serializedCalls).not.toContain('sk-secret');
        expect(serializedCalls).not.toContain('blob-ref-secret');
        expect(serializedCalls).not.toContain('session-secret-456');
    });

    it('falls back safely when errorName is empty or unknown', () => {
        expect(createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            error: { name: '////' },
        }).errorName).toBe('UnknownError');

        expect(createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            error: {},
        }).errorName).toBe('UnknownError');
    });

    it('keeps sync attachment upload call sites on safe logging helpers', () => {
        const syncSource = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        const uploadFunctionSource = getUploadAttachmentsForSessionSource(syncSource);

        expect(uploadFunctionSource).toContain('logMissingAttachmentBlobKey({');
        expect(uploadFunctionSource).toContain('logAttachmentUploadFailure({');
        expect(uploadFunctionSource).toContain('sessionId,');
        expect(uploadFunctionSource).toContain('uploadRef,');
        expect(uploadFunctionSource).not.toContain('[attachments] Failed to upload');
        expect(uploadFunctionSource).not.toContain('No blob key for session');
        expect(uploadFunctionSource).not.toContain('console.error');
        expect(uploadFunctionSource).not.toContain('attachment.name}:');
        expect(uploadFunctionSource).not.toContain('attachment.name}:`, err');
    });
});

function getUploadAttachmentsForSessionSource(source: string): string {
    const start = source.indexOf('private async uploadAttachmentsForSession');
    const end = source.indexOf('\n    async sendMessage', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    return source.slice(start, end);
}
