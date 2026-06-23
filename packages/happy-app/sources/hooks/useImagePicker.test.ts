import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
    manipulateAsync: vi.fn(),
    generateThumbhash: vi.fn(),
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
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

// Picker hook also imports these for takePhoto/pickFiles/pasteImage. Mock them
// so the module graph does not load expo-modules-core (references __DEV__) at import.
vi.mock('expo-document-picker', () => ({
    getDocumentAsync: vi.fn(),
}));

vi.mock('expo-clipboard', () => ({
    getImageAsync: vi.fn(),
}));

vi.mock('expo-file-system/legacy', () => ({
    writeAsStringAsync: vi.fn(),
    cacheDirectory: 'file:///cache/',
    EncodingType: { Base64: 'base64' },
}));

vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
}));

import { normalizePickedAssetForUpload } from './useImagePicker';

describe('normalizePickedAssetForUpload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platform.OS = 'ios';
    });

    it('normalizes iOS image picker assets to JPEG before upload', async () => {
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            width: 4032,
            height: 3024,
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
            [],
            { compress: expect.any(Number), format: 'jpeg' },
        );
        expect(normalized).toEqual({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_9824.jpg',
            width: 4032,
            height: 3024,
        });
    });
});
