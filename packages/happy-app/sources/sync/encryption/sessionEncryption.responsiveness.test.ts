import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEncryption } from './sessionEncryption';
import { EncryptionCache } from './encryptionCache';
import type { ApiMessage } from '../apiTypes';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform }));

// A local codec keeps this scheduling test independent of native crypto I/O.
const codec = {
    encrypt: async () => [],
    decrypt: async (data: Uint8Array[]) => data.map(bytes => JSON.parse(new TextDecoder().decode(bytes))),
};
const messages = (count: number): ApiMessage[] => Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, seq: index + 1, localId: null, createdAt: index, updatedAt: index,
    content: { t: 'encrypted', c: btoa(JSON.stringify({ index })) },
}));

describe('history decryption responsiveness', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    it.each(['timer', 'scheduler'])('lets input run before a large Web history batch completes (%s)', async (scheduling) => {
        platform.OS = 'web';
        vi.stubGlobal('scheduler', scheduling === 'scheduler' ? {
            yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
        } : undefined);
        const session = new SessionEncryption('session', codec, new EncryptionCache());
        let inputHandled = false;
        const input = setTimeout(() => { inputHandled = true; }, 0);
        try {
            const result = await session.decryptMessages(messages(100));
            expect(inputHandled).toBe(true);
            expect(result.map(message => message?.content)).toEqual(
                Array.from({ length: 100 }, (_, index) => ({ index })),
            );
            expect(result[99]).toMatchObject({ id: 'message-99', seq: 100, createdAt: 99 });
        } finally { clearTimeout(input); }
    });

    it('services later input when decryption spends another time budget', async () => {
        platform.OS = 'web';
        vi.stubGlobal('scheduler', undefined);
        let clock = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        let inputHandled = false;
        let input: ReturnType<typeof setTimeout> | undefined;
        let decryptCalls = 0;
        const slowCodec = {
            encrypt: codec.encrypt,
            decrypt: async (bytes: Uint8Array[]) => {
                const result = await codec.decrypt(bytes);
                if (++decryptCalls === 2) input = setTimeout(() => { inputHandled = true; }, 0);
                clock += 10; // Crypto work consumed another frame's time budget.
                return result;
            },
        };
        try {
            await new SessionEncryption('session', slowCodec, new EncryptionCache()).decryptMessages(messages(1024));
            expect(inputHandled).toBe(true);
        } finally { if (input) clearTimeout(input); }
    });

    it('does not cache earlier encrypted rows when a later batch is malformed', async () => {
        platform.OS = 'web';
        const cache = new EncryptionCache();
        const session = new SessionEncryption('session', codec, cache);
        const rows = messages(40);
        rows[39].content = { t: 'encrypted', c: '!' };
        await expect(session.decryptMessages(rows)).rejects.toThrow();
        expect(cache.getCachedMessage('message-0')).toBeNull();
        expect(cache.getCachedMessage('message-17')).toBeNull();
    });

    it('preserves cache hits and failed decryptions in their original positions', async () => {
        platform.OS = 'web';
        const session = new SessionEncryption('session', codec, new EncryptionCache());
        const rows = messages(40);
        rows[17].content = { t: 'encrypted', c: btoa('null') };
        const cached = await session.decryptMessages([rows[0]]);
        const result = await session.decryptMessages(rows);
        expect(result[0]).toBe(cached[0]);
        expect(result[17]?.content).toBeNull();
        expect(result[18]?.content).toEqual({ index: 18 });
        expect(result[39]?.content).toEqual({ index: 39 });
    });

    it('keeps native decryption free of browser scheduling delays', async () => {
        platform.OS = 'android';
        let inputHandled = false;
        const input = setTimeout(() => { inputHandled = true; }, 0);
        try {
            const session = new SessionEncryption('session', codec, new EncryptionCache());
            const result = await session.decryptMessages(messages(100));
            expect(result).toHaveLength(100);
            expect(inputHandled).toBe(false);
        } finally { clearTimeout(input); platform.OS = 'web'; }
    });
});
