import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Modal } from '@/modal';
import { normalizeImageForUpload } from '@/utils/normalizeImageForUpload';
import { MAX_IMAGES_PER_MESSAGE, MAX_PDF_FILE_SIZE, useImagePicker } from './useImagePicker';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
}));
// Same reason as normalizeImageForUpload below: importing the real
// expo-document-picker drags in expo-modules-core (__DEV__ undefined in node).
vi.mock('expo-document-picker', () => ({
    getDocumentAsync: vi.fn(),
}));
vi.mock('expo-file-system/legacy', () => ({
    getInfoAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Keyboard: { dismiss: () => {}, isVisible: () => false, addListener: vi.fn() },
}));
vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));
vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: vi.fn(),
}));
// Stub the normalizer so importing the hook doesn't pull in expo-image-manipulator
// (→ expo-modules-core, which references __DEV__ and blows up in the node test env).
vi.mock('@/utils/normalizeImageForUpload', () => ({
    normalizeImageForUpload: vi.fn(),
}));
// AttachmentSourceSheet drags in @expo/vector-icons + unistyles (expo-modules-core
// → __DEV__ undefined in node). Not exercised by these constant-focused tests.
vi.mock('@/components/AttachmentSourceSheet', () => ({
    AttachmentSourceSheet: () => null,
}));
vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useImagePicker limits', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
        vi.mocked(normalizeImageForUpload).mockReset();
        vi.mocked(Modal.alert).mockReset();
    });

    it('allows up to 50 images per message', () => {
        expect(MAX_IMAGES_PER_MESSAGE).toBe(50);
    });

    it('caps PDFs at 10MB while the encrypted flow still buffers whole files', () => {
        expect(MAX_PDF_FILE_SIZE).toBe(10 * 1024 * 1024);
    });

    it('supports a smaller feature-specific attachment limit', async () => {
        let current: ReturnType<typeof useImagePicker> | null = null;
        function Probe() {
            current = useImagePicker({ maxAttachments: 4 });
            return null;
        }
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        const images = Array.from({ length: 5 }, (_, index) => ({
            id: `image-${index}`,
            uri: `file:///image-${index}.jpg`,
            width: 100,
            height: 100,
            mimeType: 'image/jpeg',
            size: 100,
            name: `image-${index}.jpg`,
        }));

        act(() => current?.addImages(images));

        expect((current as ReturnType<typeof useImagePicker> | null)?.selectedImages).toHaveLength(4);
        act(() => renderer.unmount());
    });

    it('rejects images above a feature-specific size limit before normalization', async () => {
        let current: ReturnType<typeof useImagePicker> | null = null;
        function Probe() {
            current = useImagePicker({ maxAttachments: 4, maxImageSizeBytes: 10 * 1024 * 1024 });
            return null;
        }
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'file:///large.png',
                width: 100,
                height: 100,
                fileName: 'large.png',
                fileSize: 11 * 1024 * 1024,
                mimeType: 'image/png',
            }],
        } as any);

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        await act(async () => {
            await (current as ReturnType<typeof useImagePicker> | null)?.pickImages();
        });

        expect(normalizeImageForUpload).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalledWith(
            'imageUpload.fileTooLargeTitle',
            'imageUpload.fileTooLargeMessage',
            [{ text: 'common.ok' }],
        );
        expect((current as ReturnType<typeof useImagePicker> | null)?.selectedImages).toEqual([]);
        act(() => renderer.unmount());
    });

    it('allows a one-image feature to clear and reopen the picker in the same press', async () => {
        let current: ReturnType<typeof useImagePicker> | null = null;
        function Probe() {
            current = useImagePicker({ maxAttachments: 1 });
            return null;
        }
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: [] } as any);
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        act(() => current?.addImages([{
            id: 'old-cover',
            uri: 'file:///old-cover.jpg',
            width: 100,
            height: 100,
            mimeType: 'image/jpeg',
            size: 100,
            name: 'old-cover.jpg',
        }]));

        await act(async () => {
            current?.clearImages();
            await current?.pickImages();
        });

        expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledOnce();
        expect(Modal.alert).not.toHaveBeenCalledWith(
            'imageUpload.limitTitle',
            'imageUpload.limitMessage',
            [{ text: 'common.ok' }],
        );
        act(() => renderer.unmount());
    });
});

describe('useImagePicker PDF documents', () => {
    let current: ReturnType<typeof useImagePicker> | null = null;

    function Probe() {
        current = useImagePicker();
        return null;
    }

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        current = null;
        vi.mocked(DocumentPicker.getDocumentAsync).mockReset();
        vi.mocked(getInfoAsync).mockReset();
    });

    it('opens a PDF-only document picker and adds a generic file attachment', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'file:///tmp/floor-plan.pdf',
                name: 'floor-plan.pdf',
                size: 2048,
                mimeType: 'application/pdf',
                lastModified: 0,
                file: { size: 2048 } as File,
            }],
        });

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });

        const pickPdf = (current as any)?.pickPdf;
        expect(typeof pickPdf).toBe('function');
        if (typeof pickPdf !== 'function') return;

        await act(async () => {
            await pickPdf();
        });

        expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith({
            type: 'application/pdf',
            multiple: true,
            copyToCacheDirectory: true,
        });
        expect(current?.selectedImages).toEqual([
            expect.objectContaining({
                uri: 'file:///tmp/floor-plan.pdf',
                name: 'floor-plan.pdf',
                size: 2048,
                mimeType: 'application/pdf',
                kind: 'file',
            }),
        ]);
        act(() => renderer.unmount());
    });

    it('checks the real file size when the document picker omits it', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'file:///tmp/oversized-plan.pdf',
                name: 'oversized-plan.pdf',
                mimeType: 'application/pdf',
                lastModified: 0,
            }],
        });
        vi.mocked(getInfoAsync).mockResolvedValue({
            exists: true,
            isDirectory: false,
            uri: 'file:///tmp/oversized-plan.pdf',
            size: 11 * 1024 * 1024,
            modificationTime: 0,
        });

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        const pickPdf = (current as any)?.pickPdf;
        expect(typeof pickPdf).toBe('function');
        if (typeof pickPdf !== 'function') return;

        await act(async () => {
            await pickPdf();
        });

        expect(getInfoAsync).toHaveBeenCalledWith('file:///tmp/oversized-plan.pdf');
        expect(current?.selectedImages).toEqual([]);
        act(() => renderer.unmount());
    });

    it('fails closed when a PDF with no reported size cannot be inspected', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'file:///tmp/unreadable-plan.pdf',
                name: 'unreadable-plan.pdf',
                mimeType: 'application/pdf',
                lastModified: 0,
            }],
        });
        vi.mocked(getInfoAsync).mockRejectedValue(new Error('stat failed'));

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        const pickPdf = (current as any)?.pickPdf;
        expect(typeof pickPdf).toBe('function');
        if (typeof pickPdf !== 'function') return;

        await expect(act(async () => {
            await pickPdf();
        })).resolves.toBeUndefined();

        expect(current?.selectedImages).toEqual([]);
        act(() => renderer.unmount());
    });

    it('rejects an underreported PDF using the browser File size', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'blob:underreported-plan',
                name: 'underreported-plan.pdf',
                size: 1,
                mimeType: 'application/pdf',
                lastModified: 0,
                file: { size: 11 * 1024 * 1024 } as File,
            }],
        });

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });
        const pickPdf = (current as any)?.pickPdf;
        expect(typeof pickPdf).toBe('function');
        if (typeof pickPdf !== 'function') return;

        await act(async () => {
            await pickPdf();
        });

        expect(getInfoAsync).not.toHaveBeenCalled();
        expect(current?.selectedImages).toEqual([]);
        act(() => renderer.unmount());
    });
});
