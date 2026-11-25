import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    save: vi.fn(),
    available: vi.fn(),
    share: vi.fn(),
    stage: vi.fn(),
}));
vi.mock('expo-media-library', () => ({ saveToLibraryAsync: mocks.save }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: mocks.available, shareAsync: mocks.share }));
vi.mock('./createMediaPlaybackSource', () => ({ downloadMediaPlaybackSource: mocks.stage }));

import { saveVideoAttachment } from './saveVideoAttachment';

describe('native video saving', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.save.mockResolvedValue(undefined);
        mocks.available.mockResolvedValue(true);
        mocks.share.mockResolvedValue(undefined);
    });

    it('saves staged MP4 bytes to the library without sharing or releasing the caller-owned file', async () => {
        const release = vi.fn();
        await expect(saveVideoAttachment({ uri: 'file:///cache/clip.mp4', headers: {}, release }, 'clip.mp4', 'video/mp4')).resolves.toBe('saved');
        expect(mocks.save).toHaveBeenCalledWith('file:///cache/clip.mp4');
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.share).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it('exports through the system share sheet if the library cannot accept the video', async () => {
        mocks.save.mockRejectedValue(new Error('Missing storage permission'));
        await expect(saveVideoAttachment({ uri: 'file:///cache/clip.mp4', headers: {} }, 'clip.mp4', 'video/mp4')).resolves.toBe('shared');
        expect(mocks.share).toHaveBeenCalledWith('file:///cache/clip.mp4', { dialogTitle: 'clip.mp4', mimeType: 'video/mp4' });
    });

    it('stages a public video locally and keeps it alive until the native export finishes', async () => {
        const release = vi.fn();
        let finishSave!: () => void;
        mocks.stage.mockResolvedValue({ uri: 'file:///cache/clip.mp4', headers: {}, release });
        mocks.save.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
        const source = { uri: 'https://media.test/clip', headers: { Authorization: 'test-only' } };
        const pending = saveVideoAttachment(source, 'clip.mp4', 'video/mp4');
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
        expect(mocks.stage).toHaveBeenCalledWith(source, 'video/mp4', 'clip.mp4');
        expect(release).not.toHaveBeenCalled();
        finishSave();
        await expect(pending).resolves.toBe('saved');
        expect(release).toHaveBeenCalledOnce();
    });

    it('reports failure and releases its staged file if neither native export is available', async () => {
        const release = vi.fn();
        mocks.stage.mockResolvedValue({ uri: 'file:///cache/clip.mp4', headers: {}, release });
        mocks.save.mockRejectedValue(new Error('Cannot save video'));
        mocks.available.mockResolvedValue(false);
        await expect(saveVideoAttachment({ uri: 'https://media.test/clip', headers: {} }, 'clip.mp4', 'video/mp4')).rejects.toThrow('Cannot save video');
        expect(release).toHaveBeenCalledOnce();
    });
});
