import { describe, expect, it } from 'vitest';
import {
    createAttachmentUploadLogMetadata,
    formatAttachmentUploadLogMessage,
} from './attachmentUploadLogging';

describe('attachment upload logging', () => {
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
});
