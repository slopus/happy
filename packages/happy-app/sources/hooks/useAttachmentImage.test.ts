import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/apiAttachments', () => ({ downloadEncryptedAttachment: vi.fn() }));
vi.mock('@/sync/attachmentDiagnostics', () => ({
    createAttachmentDiagnostic: vi.fn(),
    formatAttachmentDiagnosticForLog: vi.fn(),
    getAttachmentDiagnostic: vi.fn(),
}));
vi.mock('@/encryption/blob', () => ({ decryptBlob: vi.fn() }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: vi.fn() }));

import {
    MAX_CACHE_BYTES,
    MAX_CACHE_ENTRIES,
    getAttachmentImageCacheStats,
    rememberInCache,
} from './useAttachmentImage';

describe('attachment image cache', () => {
    it('evicts the oldest entries once the byte budget is exceeded, not only by count', () => {
        // Four of these fit under the count cap but exceed the byte budget.
        const big = 'x'.repeat(Math.ceil(MAX_CACHE_BYTES / 4) + 1);
        for (let i = 0; i < 5; i++) rememberInCache(`ref-${i}`, big);

        const stats = getAttachmentImageCacheStats();
        expect(stats.entries).toBe(3);
        expect(stats.entries).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
        expect(stats.bytes).toBeLessThanOrEqual(MAX_CACHE_BYTES);
        expect(stats.bytes).toBe(stats.entries * big.length);

        // Re-remembering a cached ref must not double count it.
        rememberInCache('ref-4', big);
        expect(getAttachmentImageCacheStats()).toEqual(stats);
    });
});
