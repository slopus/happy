import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    deriveSessionFallbackTitle,
    ensureSessionFallbackTitle,
    SESSION_FALLBACK_TITLE_MAX_LENGTH,
} from './sessionFallbackTitle';

const mocks = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    encryptRaw: vi.fn(async (metadata: unknown) => `encrypted:${JSON.stringify(metadata)}`),
    decryptRaw: vi.fn(async (metadata: string) => JSON.parse(metadata.replace(/^encrypted:/, ''))),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { emitWithAck: mocks.emitWithAck },
}));

const sessionEncryption = {
    encryptRaw: mocks.encryptRaw,
    decryptRaw: mocks.decryptRaw,
} as any;

describe('deriveSessionFallbackTitle', () => {
    it('normalizes the first user text and limits it by Unicode code points', () => {
        const title = deriveSessionFallbackTitle(`  # ${'好'.repeat(100)}\nnext line  `);
        expect(title).toBe('好'.repeat(SESSION_FALLBACK_TITLE_MAX_LENGTH));
    });

    it('uses the first attachment filename for an attachment-only message', () => {
        expect(deriveSessionFallbackTitle('   ', [
            { name: 'architecture-overview.png' },
            { name: 'ignored.png' },
        ])).toBe('architecture-overview.png');
    });

    it('returns null when neither text nor a usable filename exists', () => {
        expect(deriveSessionFallbackTitle(' \n ', [{ name: '  ' }])).toBeNull();
    });
});

describe('ensureSessionFallbackTitle', () => {
    beforeEach(() => vi.clearAllMocks());

    it('writes the encrypted fallback title when the session is untitled', async () => {
        mocks.emitWithAck.mockResolvedValueOnce({
            result: 'success',
            version: 2,
            metadata: 'encrypted:{"path":"/repo","host":"mac","summary":{"text":"First prompt","updatedAt":123}}',
        });

        const result = await ensureSessionFallbackTitle({
            sessionId: 'session-1',
            metadata: { path: '/repo', host: 'mac' },
            metadataVersion: 1,
            sessionEncryption,
            title: 'First prompt',
            now: () => 123,
        });

        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: 'session-1',
            expectedVersion: 1,
            metadata: 'encrypted:{"path":"/repo","host":"mac","summary":{"text":"First prompt","updatedAt":123}}',
        });
        expect(result.metadata.summary?.text).toBe('First prompt');
    });

    it('does not overwrite an existing manual or Agent title', async () => {
        const metadata = {
            path: '/repo',
            host: 'mac',
            summary: { text: 'Manual title', updatedAt: 99 },
        };

        const result = await ensureSessionFallbackTitle({
            sessionId: 'session-1',
            metadata,
            metadataVersion: 4,
            sessionEncryption,
            title: 'Fallback',
        });

        expect(mocks.emitWithAck).not.toHaveBeenCalled();
        expect(result).toEqual({ version: 4, metadata });
    });

    it('re-checks the latest title after a version conflict and preserves it without a retry write', async () => {
        mocks.emitWithAck.mockResolvedValueOnce({
            result: 'version-mismatch',
            version: 8,
            metadata: 'encrypted:{"path":"/repo","host":"mac","summary":{"text":"Won concurrent rename","updatedAt":456}}',
        });

        const result = await ensureSessionFallbackTitle({
            sessionId: 'session-1',
            metadata: { path: '/repo', host: 'mac' },
            metadataVersion: 7,
            sessionEncryption,
            title: 'Losing fallback',
        });

        expect(mocks.emitWithAck).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            version: 8,
            metadata: {
                path: '/repo',
                host: 'mac',
                summary: { text: 'Won concurrent rename', updatedAt: 456 },
            },
        });
    });
});
