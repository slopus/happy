import { describe, expect, it, vi } from 'vitest';

describe('getClipboardStringTrimmedSafe', () => {
    it('returns trimmed clipboard contents', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => '  hello  '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('hello');
    });

    it('returns empty string when clipboard read throws', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });
});

