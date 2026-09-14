import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
    manipulateAsync: vi.fn(),
    generateThumbhash: vi.fn(),
    getInfoAsync: vi.fn(),
    alert: vi.fn(),
    setSelectedImages: vi.fn(),
}));

// Exercise the picker callback and its state update without native UI modules.
vi.mock('react', () => ({
    useState: () => [[], mocks.setSelectedImages],
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void) => { effect(); },
}));

vi.mock('react-native', () => ({
    Platform: mocks.platform,
}));

vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: mocks.requestMediaLibraryPermissionsAsync,
    launchImageLibraryAsync: mocks.launchImageLibraryAsync,
}));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: mocks.manipulateAsync,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: mocks.alert },
}));

vi.mock('expo-file-system/legacy', () => ({
    getInfoAsync: mocks.getInfoAsync,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

import { MAX_FILE_SIZE, normalizePickedAssetForUpload, useImagePicker } from './useImagePicker';
import type { AttachmentPreview } from './useImagePicker';

const photo = {
    uri: 'file:///test/photo.HEIC',
    width: 6048,
    height: 8064,
    mimeType: 'image/heic',
    fileName: 'photo.HEIC',
    fileSize: 6_300_000,
};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.platform.OS = 'ios';
    mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: 3_000_000 });
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///test/normalized.jpg', width: 2304, height: 3072 });
    mocks.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [photo] });
    mocks.generateThumbhash.mockResolvedValue('thumbhash');
});

describe('normalizePickedAssetForUpload', () => {
    it('normalizes iOS image picker assets to JPEG before upload', async () => {
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            width: 3072,
            height: 2304,
        });

        const normalized = await normalizePickedAssetForUpload({
            uri: 'file:///tmp/IMG_9824.HEIC',
            width: 4032,
            height: 3024,
            fileName: 'IMG_9824.HEIC',
            fileSize: 2_701_533,
        });

        expect(mocks.manipulateAsync).toHaveBeenCalledWith(
            'file:///tmp/IMG_9824.HEIC',
            [{ resize: { width: 3072 } }],
            { compress: 0.92, format: 'jpeg' },
        );
        expect(normalized).toEqual({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_9824.jpg',
            width: 3072,
            height: 2304,
            size: 3_000_000,
        });
    });

    it.each([
        [6048, 8064, { height: 3072 }],
        [8064, 6048, { width: 3072 }],
        [8064, 8064, { width: 3072 }],
        [12000, 2000, { width: 3072 }],
    ])('bounds %ix%i images using one dimension to preserve framing', async (width, height, resize) => {
        await normalizePickedAssetForUpload({ ...photo, width, height });
        expect(mocks.manipulateAsync).toHaveBeenCalledExactlyOnceWith(
            photo.uri, [{ resize }], { compress: 0.92, format: 'jpeg' },
        );
    });

    it.each([[1024, 768], [3072, 2304]])('does not upscale or crop an already-small %ix%i image', async (width, height) => {
        mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///test/small.jpg', width, height });
        const normalized = await normalizePickedAssetForUpload({ ...photo, width, height, fileName: 'small.jpg', mimeType: 'image/jpeg' });
        expect(mocks.manipulateAsync).toHaveBeenCalledExactlyOnceWith(
            photo.uri, [], { compress: 0.92, format: 'jpeg' },
        );
        expect(normalized).toMatchObject({ width, height, name: 'small.jpg' });
    });

    it('measures the converted URI even when source filesize is unavailable', async () => {
        const normalized = await normalizePickedAssetForUpload({ ...photo, fileSize: undefined });
        expect(mocks.getInfoAsync).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg');
        expect(normalized).toMatchObject({ size: 3_000_000, width: 2304, height: 3072 });
    });

    it.each([
        { exists: false },
        { exists: true, isDirectory: true, size: 100 },
        { exists: true, size: undefined },
        { exists: true, size: 0 },
        { exists: true, size: -1 },
        { exists: true, size: NaN },
        { exists: true, size: Infinity },
    ])('rejects unreadable/unknown transformed filesize: %j', async (info) => {
        mocks.getInfoAsync.mockResolvedValue(info);
        await expect(normalizePickedAssetForUpload(photo)).rejects.toThrow();
    });

    it.each(['android', 'web'])('preserves the existing %s path', async (platform) => {
        mocks.platform.OS = platform;
        const normalized = await normalizePickedAssetForUpload(photo);
        expect(normalized).toEqual({
            uri: photo.uri, width: photo.width, height: photo.height,
            mimeType: photo.mimeType, name: photo.fileName, size: photo.fileSize,
        });
        expect(mocks.manipulateAsync).not.toHaveBeenCalled();
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
    });
});

describe('useImagePicker transformed upload validation', () => {
    function addedImages(): AttachmentPreview[] {
        expect(mocks.setSelectedImages).toHaveBeenCalledTimes(1);
        return mocks.setSelectedImages.mock.calls[0][0]([]);
    }

    it('adds the converted bytes/size, not the original oversized HEIC', async () => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ ...photo, fileSize: MAX_FILE_SIZE + 1 }] });
        await useImagePicker().pickImages();
        expect(addedImages()).toEqual([expect.objectContaining({
            uri: 'file:///test/normalized.jpg', size: 3_000_000,
            width: 2304, height: 3072, name: 'photo.jpg', mimeType: 'image/jpeg', thumbhash: 'thumbhash',
        })]);
        expect(mocks.generateThumbhash).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg', 2304, 3072);
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it.each([MAX_FILE_SIZE + 1, MAX_FILE_SIZE, MAX_FILE_SIZE - 39])('rejects transformed size %i including encryption overhead', async (size) => {
        mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size });
        await useImagePicker().pickImages();
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.fileTooLargeTitle', 'imageUpload.fileTooLargeMessage', expect.any(Array));
        expect(mocks.generateThumbhash).not.toHaveBeenCalled();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
    });

    it('accepts the exact encrypted upload boundary and reports plaintext bytes', async () => {
        mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_FILE_SIZE - 40 });
        await useImagePicker().pickImages();
        expect(addedImages()[0].size).toBe(MAX_FILE_SIZE - 40);
    });

    it('accepts unknown original filesize after measuring the JPEG', async () => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ ...photo, fileSize: undefined }] });
        await useImagePicker().pickImages();
        expect(addedImages()[0].size).toBe(3_000_000);
    });

    it.each(['manipulateAsync', 'getInfoAsync'] as const)('isolates %s failure without dropping valid sibling images', async (operation) => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [photo, photo] });
        mocks[operation].mockRejectedValueOnce(new Error('native failure'));
        await expect(useImagePicker().pickImages()).resolves.toBeUndefined();
        expect(addedImages()).toHaveLength(1);
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.uploadFailedTitle', 'imageUpload.uploadFailedMessage', expect.any(Array));
    });

    it('does not add an image whose converted size is unavailable', async () => {
        mocks.getInfoAsync.mockResolvedValue({ exists: false });
        await expect(useImagePicker().pickImages()).resolves.toBeUndefined();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledTimes(1);
    });

    it.each([{ canceled: true, assets: null }, { canceled: false, assets: [] }])('does nothing on canceled/empty selection', async (result) => {
        mocks.launchImageLibraryAsync.mockResolvedValue(result);
        await useImagePicker().pickImages();
        expect(mocks.manipulateAsync).not.toHaveBeenCalled();
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).not.toHaveBeenCalled();
    });
});
