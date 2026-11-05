import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    readVoiceConfig: vi.fn(),
    synthesize: vi.fn(),
}));
vi.mock('./synthesize', () => mocks);
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { registerReadAloudHandler } from './registerReadAloudHandler';
import { piperArchiveUrl } from './piperVoices';

function handlers() {
    const map = new Map<string, (params: any) => Promise<any>>();
    registerReadAloudHandler({ registerHandler: (m: string, h: any) => map.set(m, h) } as any);
    return map;
}

describe('registerReadAloudHandler', () => {
    beforeEach(() => vi.resetAllMocks());

    it('answers not-configured instead of failing when setup never ran', async () => {
        mocks.readVoiceConfig.mockReturnValue(null);
        const h = handlers();
        expect(await h.get('read-aloud')!({ text: 'Hallo' })).toEqual({ ok: false, reason: 'not-configured' });
        expect(mocks.synthesize).not.toHaveBeenCalled();
    });

    it('returns the WAV as base64 with the configured voice', async () => {
        mocks.readVoiceConfig.mockReturnValue({ voice: 'en_US-hfc_female-medium' });
        mocks.synthesize.mockResolvedValue(Buffer.from('RIFF'));
        const h = handlers();
        expect(await h.get('read-aloud')!({ text: 'Hallo' })).toEqual({ ok: true, audioBase64: 'UklGRg==', mimeType: 'audio/wav' });
        expect(mocks.synthesize).toHaveBeenCalledWith('Hallo', 'en_US-hfc_female-medium');
    });
});

describe('piperArchiveUrl', () => {
    it('maps platform/arch to the release archive, null when unsupported', () => {
        expect(piperArchiveUrl('linux', 'x64')).toMatch(/piper_linux_x86_64\.tar\.gz$/);
        expect(piperArchiveUrl('win32', 'x64')).toMatch(/piper_windows_amd64\.zip$/);
        expect(piperArchiveUrl('win32', 'arm64')).toBeNull();
    });
});
