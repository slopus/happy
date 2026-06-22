import { describe, expect, it } from 'vitest';

import {
    AttachmentDiagnosticError,
    classifyAttachmentTransferTarget,
    createAttachmentDiagnostic,
    createAttachmentDiagnosticError,
    errorMessageFromUnknown,
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

    it('does not emit dirty URL hosts from raw diagnostics', () => {
        const dirtyDiagnostic = createAttachmentDiagnostic({
            leg: 'blob-download',
            url: 'https://X-Amz-Signature=secret',
            serverUrl: 'https://api.cluster-fluster.com',
        });
        const safeDiagnostic = createAttachmentDiagnostic({
            leg: 'blob-download',
            url: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            serverUrl: 'https://api.cluster-fluster.com',
        });

        expect(dirtyDiagnostic).not.toHaveProperty('host');
        expect(safeDiagnostic.host).toBe('files.cluster-fluster.com');

        const serialized = JSON.stringify(dirtyDiagnostic).toLowerCase();
        expect(serialized).not.toContain('x-amz-signature');
        expect(serialized).not.toContain('signature');
        expect(serialized).not.toContain('secret');
    });

    it('sanitizes unsafe messages and reasons before serialization', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'blob-download',
            method: 'GET',
            url: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            serverUrl: 'https://api.cluster-fluster.com',
            message: 'Fetch failed for https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret&policy=secret using Bearer secret-token',
            reason: 'Read failed from file:///Users/devdvlive/Projects/happy/local.bin and /Users/devdvlive/Projects/happy/other.bin',
        });

        expect(diagnostic.message).toContain('files.cluster-fluster.com');
        expect(diagnostic.reason).toContain('[local-file]');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('policy');
        expect(serialized).not.toContain('Bearer');
        expect(serialized).not.toContain('/happy/ref');
        expect(serialized).not.toContain('/Users/devdvlive');
        expect(serialized).not.toContain('local.bin');
        expect(serialized).not.toContain('other.bin');
    });

    it('redacts non-http absolute URLs in diagnostic text', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'blob-download',
            method: 'GET',
            message: 'Fetch failed for s3://bucket/happy/ref?X-Amz-Signature=secret',
            reason: 'missing-blob-key',
        });

        expect(diagnostic.message).toContain('[url:bucket]');
        expect(diagnostic.reason).toBe('missing-blob-key');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('/happy/ref');
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('secret');
    });

    it('redacts data URI payloads in diagnostic text', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Failed to fetch',
            reason: 'Preview failed for data:image/png;base64,iVBORw0KGgoSECRET',
        });

        expect(diagnostic.message).toBe('Failed to fetch');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[data-uri]');
        expect(serialized).not.toContain('data:image');
        expect(serialized).not.toContain('base64');
        expect(serialized).not.toContain('iVBORw0KGgoSECRET');
    });

    it('redacts data URI payloads containing spaces', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Failed to fetch',
            reason: 'Preview failed for data:text/plain,hello world SECRET',
        });

        expect(diagnostic.message).toBe('Failed to fetch');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[data-uri]');
        expect(serialized).not.toContain('data:text/plain');
        expect(serialized).not.toContain('hello');
        expect(serialized).not.toContain('world');
        expect(serialized).not.toContain('SECRET');
    });

    it('redacts multiline data URI payloads in diagnostic text', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Failed to fetch',
            reason: 'Preview failed for data:text/plain,hello\nSECRET',
        });

        expect(diagnostic.message).toBe('Failed to fetch');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[data-uri]');
        expect(serialized).not.toContain('data:text/plain');
        expect(serialized).not.toContain('hello');
        expect(serialized).not.toContain('SECRET');
    });

    it('redacts generic scheme-token payloads from error messages', () => {
        const blobMessage = errorMessageFromUnknown(new Error('blob:secret-payload'));
        const mailtoMessage = errorMessageFromUnknown(new Error('mailto:user@example.com'));

        expect(blobMessage).toBe('[url:blob]');
        expect(mailtoMessage).toBe('[url:mailto]');
        expect(errorMessageFromUnknown(new Error('Failed to fetch'))).toBe('Failed to fetch');

        const serialized = JSON.stringify([blobMessage, mailtoMessage]);
        expect(serialized).not.toContain('blob:secret-payload');
        expect(serialized).not.toContain('secret-payload');
        expect(serialized).not.toContain('mailto:user@example.com');
        expect(serialized).not.toContain('user@example.com');
    });

    it('redacts desktop local paths with spaces in path segments', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Failed to fetch',
            reason: 'Read failed from /Users/devdvlive/My Projects/happy/blob.bin',
        });

        expect(diagnostic.message).toBe('Failed to fetch');
        expect(diagnostic.reason).toContain('[local-file]');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('/Users/devdvlive');
        expect(serialized).not.toContain('My Projects');
        expect(serialized).not.toContain('happy/blob.bin');
        expect(serialized).not.toContain('blob.bin');
    });

    it('redacts file URI local paths with spaces in path segments', () => {
        const source = 'Read failed from file:///Users/devdvlive/My Projects/happy/blob.bin';
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            reason: source,
        });

        const serialized = JSON.stringify(diagnostic);
        const message = errorMessageFromUnknown(new Error(source));

        expect(serialized).toContain('[local-file]');
        expect(message).toContain('[local-file]');
        for (const rendered of [serialized, message]) {
            expect(rendered).not.toContain('file:///Users');
            expect(rendered).not.toContain('My Projects');
            expect(rendered).not.toContain('Projects/happy');
            expect(rendered).not.toContain('blob.bin');
        }
    });

    it('redacts Windows desktop local paths with spaces in path segments', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            reason: 'Read failed from C:\\Users\\devdvlive\\My Projects\\happy\\blob.bin',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[local-file]');
        expect(serialized).not.toContain('C:\\Users');
        expect(serialized).not.toContain('My Projects');
        expect(serialized).not.toContain('Projects\\happy');
        expect(serialized).not.toContain('blob.bin');
    });

    it('redacts forward-slash Windows local paths with spaces in path segments', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            reason: 'Read failed from C:/Users/devdvlive/My Projects/happy/blob.bin',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[local-file]');
        expect(serialized).not.toContain('C:/Users');
        expect(serialized).not.toContain('My Projects');
        expect(serialized).not.toContain('happy/blob.bin');
        expect(serialized).not.toContain('blob.bin');
    });

    it('redacts arbitrary Windows drive local paths before generic scheme handling', () => {
        const sources = [
            'Read failed from D:\\Photos\\Private Album\\secret.jpg',
            'Read failed from D:/Photos/Private Album/secret.jpg',
        ];

        for (const source of sources) {
            const diagnostic = createAttachmentDiagnostic({
                leg: 'decrypt-render',
                message: 'Failed to fetch',
                reason: source,
            });
            const rendered = `${JSON.stringify(diagnostic)} ${errorMessageFromUnknown(new Error(source))}`;

            expect(diagnostic.message).toBe('Failed to fetch');
            expect(rendered).toContain('[local-file]');
            expect(rendered).not.toContain('D:\\Photos');
            expect(rendered).not.toContain('D:/Photos');
            expect(rendered).not.toContain('Private Album');
            expect(rendered).not.toContain('secret.jpg');
        }
    });

    it('redacts assignment-prefixed local paths before diagnostic serialization', () => {
        const sources = [
            'path=/Users/dev/My Projects/blob.bin',
            'path=/data/user/0/com.happy/cache/blob.bin',
            'path=C:\\Users\\dev\\My Projects\\blob.bin',
            'path=C:/Users/dev/My Projects/blob.bin',
        ];

        for (const source of sources) {
            const diagnostic = createAttachmentDiagnostic({
                leg: 'decrypt-render',
                message: 'Failed to fetch',
                reason: source,
            });
            const rendered = `${JSON.stringify(diagnostic)} ${errorMessageFromUnknown(new Error(source))}`;

            expect(diagnostic.message).toBe('Failed to fetch');
            expect(rendered).toContain('path=[local-file]');
            expect(rendered).not.toContain('/Users');
            expect(rendered).not.toContain('/data/user/0');
            expect(rendered).not.toContain('C:\\Users');
            expect(rendered).not.toContain('C:/Users');
            expect(rendered).not.toContain('My Projects');
            expect(rendered).not.toContain('com.happy');
            expect(rendered).not.toContain('blob.bin');
        }
    });

    it('redacts mobile local paths in messages and reasons', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Read failed from /data/user/0/com.happy/cache/blob.bin',
            reason: 'Missing file at /storage/emulated/0/Download/photo.png and /sdcard/Pictures/photo.png',
        });

        expect(diagnostic.message).toContain('[local-file]');
        expect(diagnostic.reason).toContain('[local-file]');

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('/data/user/0');
        expect(serialized).not.toContain('/storage/emulated/0');
        expect(serialized).not.toContain('/sdcard');
        expect(serialized).not.toContain('blob.bin');
        expect(serialized).not.toContain('photo.png');
    });

    it('redacts Android app data paths in reasons', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            reason: 'Read failed from /data/data/com.happy/cache/blob.bin',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[local-file]');
        expect(serialized).not.toContain('/data/data');
        expect(serialized).not.toContain('com.happy');
        expect(serialized).not.toContain('blob.bin');
    });

    it('sanitizes dirty whitelisted fields when formatting diagnostics for logs', () => {
        const rendered = formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            method: 'GET',
            host: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden from https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            message: 'Failed to fetch',
            reason: 'missing-blob-key',
        }, {
            platform: 'web happy/session-1/ref',
            client: 'web/1.2.3 Bearer secret-token /data/data/com.happy/cache/blob.bin',
        });

        expect(rendered.host).toBe('files.cluster-fluster.com');
        expect(rendered.message).toBe('Failed to fetch');
        expect(rendered.reason).toBe('missing-blob-key');

        const serialized = JSON.stringify(rendered);
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('/happy/ref');
        expect(serialized).not.toContain('Bearer');
        expect(serialized).not.toContain('/data/data');
        expect(serialized).not.toContain('com.happy');
        expect(serialized).not.toContain('blob.bin');
        expect(serialized).not.toContain('happy/session-1/ref');
    });

    it('drops dirty key-value host output', () => {
        const rendered = formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'X-Amz-Signature=secret&policy=secret',
        });

        const serialized = JSON.stringify(rendered);
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('policy');
        expect(serialized).not.toContain('secret');
    });

    it('drops dirty non-host values from host output', () => {
        const rendered = [
            'C:\\Users\\devdvlive\\My Projects\\happy\\blob.bin',
            'data:,SECRET',
            'user:secret@files.cluster-fluster.com',
            'file:///Users/devdvlive/My Projects/happy/blob.bin',
        ].map((host) => formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host,
        }));

        const serialized = JSON.stringify(rendered);
        expect(serialized).not.toContain('host');
        expect(serialized).not.toContain('C:\\Users');
        expect(serialized).not.toContain('My Projects');
        expect(serialized).not.toContain('blob.bin');
        expect(serialized).not.toContain('SECRET');
        expect(serialized).not.toContain('user');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('@');
        expect(serialized).not.toContain('file:///Users');
    });

    it('validates host values extracted from URLs before log formatting', () => {
        const dirtyKeyValueHost = formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'https://X-Amz-Signature=secret',
        });
        const userInfoHost = formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'https://user:secret@files.cluster-fluster.com/path',
        });

        expect(dirtyKeyValueHost).not.toHaveProperty('host');
        expect(userInfoHost.host).toBe('files.cluster-fluster.com');

        const serialized = JSON.stringify([dirtyKeyValueHost, userInfoHost]);
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('user');
        expect(serialized).not.toContain('@');
    });

    it('preserves safe host values', () => {
        expect(formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'files.cluster-fluster.com',
        }).host).toBe('files.cluster-fluster.com');
        expect(formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'api.cluster-fluster.com:3005',
        }).host).toBe('api.cluster-fluster.com:3005');
        expect(formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: '127.0.0.1:3005',
        }).host).toBe('127.0.0.1:3005');
        expect(formatAttachmentDiagnosticForLog({
            leg: 'blob-download',
            host: 'localhost:3005',
        }).host).toBe('localhost:3005');
    });

    it('drops unknown fields when extracting and formatting diagnostics', () => {
        const dirtyDiagnostic = {
            leg: 'blob-download',
            method: 'GET',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            message: 'Failed to fetch',
            reason: 'missing-blob-key',
            url: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
            ref: 'happy/session-1/ref',
        } as ConstructorParameters<typeof AttachmentDiagnosticError>[1] & {
            url: string;
            ref: string;
        };
        const error = new AttachmentDiagnosticError('Failed to fetch', dirtyDiagnostic);
        Object.setPrototypeOf(error, Error.prototype);

        expect(error).not.toBeInstanceOf(AttachmentDiagnosticError);
        const extracted = getAttachmentDiagnostic(error);
        expect(extracted).not.toHaveProperty('url');
        expect(extracted).not.toHaveProperty('ref');

        const rendered = formatAttachmentDiagnosticForLog(extracted!, {
            platform: 'web',
            client: 'web/1.2.3',
        });
        expect(rendered).not.toHaveProperty('url');
        expect(rendered).not.toHaveProperty('ref');

        const serialized = JSON.stringify(rendered);
        expect(serialized).not.toContain('"url"');
        expect(serialized).not.toContain('"ref"');
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('happy/session-1/ref');
    });

    it('redacts bare attachment refs in messages and reasons', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'Render failed for ref: happy/session-1/ref and ref happy/session-1/ref',
            reason: 'missing blob key (ref=sessions/abc/attachments/secret-ref)',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('ref=sessions/abc/attachments/secret-ref');
        expect(serialized).not.toContain('sessions/abc/attachments/secret-ref');
        expect(serialized).not.toContain('happy/session-1/ref');
        expect(serialized).toContain('[attachment-ref]');
    });

    it('redacts standalone slash-bearing attachment refs in messages and reasons', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'happy/session-1/ref',
            reason: 'missing-blob-key happy/session-1/ref',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('happy/session-1/ref');
        expect(serialized).toContain('[attachment-ref]');
    });

    it('redacts leading-slash attachment refs in messages and reasons', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            message: 'missing /happy/session-1/ref?X-Amz-Signature=secret',
            reason: 'ref=/happy/session-1/ref',
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).toContain('[attachment-ref]');
        expect(serialized).not.toContain('/happy/session-1/ref');
        expect(serialized).not.toContain('ref=/happy/session-1/ref');
        expect(serialized).not.toContain('X-Amz-Signature');
    });

    it('omits target for local decrypt diagnostics without an attempted transfer URL', () => {
        const diagnostic = createAttachmentDiagnostic({
            leg: 'decrypt-render',
            reason: 'missing-blob-key',
        });

        expect(diagnostic).toEqual({
            leg: 'decrypt-render',
            reason: 'missing-blob-key',
        });
        expect(diagnostic).not.toHaveProperty('target');
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

    it('sanitizes unsafe wrapper error messages', () => {
        const error = createAttachmentDiagnosticError(
            'Blob upload failed for https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret using Bearer secret-token at /data/user/0/com.happy/cache/blob.bin',
            {
                leg: 'blob-upload',
                method: 'POST',
                url: 'https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret',
                serverUrl: 'https://api.cluster-fluster.com',
            },
        );

        expect(error.message).toContain('files.cluster-fluster.com');
        expect(errorMessageFromUnknown(error)).toBe(error.message);
        expect(errorMessageFromUnknown(new Error('Failed to fetch'))).toBe('Failed to fetch');

        const serialized = error.message;
        expect(serialized).not.toContain('X-Amz-Signature');
        expect(serialized).not.toContain('Bearer');
        expect(serialized).not.toContain('/happy/ref');
        expect(serialized).not.toContain('/data/user/0');
        expect(serialized).not.toContain('blob.bin');
    });

    it('extracts diagnostics when the custom error prototype is broken', () => {
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

        Object.setPrototypeOf(error, Error.prototype);

        expect(error).not.toBeInstanceOf(AttachmentDiagnosticError);
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: 'files.cluster-fluster.com',
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
    });

    it('returns null for ordinary errors', () => {
        expect(getAttachmentDiagnostic(new Error('plain failure'))).toBeNull();
        expect(getAttachmentDiagnostic('plain failure')).toBeNull();
        expect(getAttachmentDiagnostic({
            diagnostic: {
                leg: 'blob-upload',
            },
        })).toBeNull();
    });
});
