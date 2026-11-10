import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { normalizeImageForUpload } from '@/utils/normalizeImageForUpload';
import { generateThumbhash } from '@/utils/thumbhash';
import {
    clearComposeDraft,
    composeDraftAttachmentSelectionGeneration,
    useComposeDraft,
} from '@/sync/composeDraft';
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
    Image: { getSize: (_uri: string, success: (w: number, h: number) => void) => success(640, 480) },
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

    it('opens an unrestricted document picker and adds a generic file attachment', async () => {
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
            type: '*/*',
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

    it('preserves arbitrary document metadata and image dimensions from the file picker', async () => {
        let current: ReturnType<typeof useImagePicker> | null = null;
        function Probe() { current = useImagePicker(); return null; }
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [
            { uri: 'file:///report.docx', name: 'report.docx', size: 4, lastModified: 0, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file: { size: 4 } as File },
            { uri: 'file:///photo.png', name: 'photo.png', size: 5, lastModified: 0, mimeType: 'image/png', file: { size: 5 } as File },
        ] });
        vi.mocked(normalizeImageForUpload).mockResolvedValue({ uri: 'file:///photo.png', mimeType: 'image/png', size: 5, width: 640, height: 480 });
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });
        await act(async () => { await current!.pickPdf(); });
        expect(normalizeImageForUpload).toHaveBeenCalledWith('file:///photo.png', 640, 480);
        expect(current!.selectedImages).toEqual([
            expect.objectContaining({ name: 'report.docx', kind: 'file', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
            expect.objectContaining({ name: 'photo.png', width: 640, height: 480 }),
        ]);
        act(() => renderer.unmount());
    });

    it('discards a pending drop when its draft is cleared', async () => {
        let current: ReturnType<typeof useImagePicker> | null = null;
        function Probe() { current = useImagePicker(); return null; }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });
        const finishDrop = current!.prepareAddImages();
        act(() => current!.clearImages());
        act(() => finishDrop([{ id: 'old', uri: 'file:///old', width: 0, height: 0, size: 1, name: 'old.txt', mimeType: 'text/plain', kind: 'file' }]));
        expect(current!.selectedImages).toHaveLength(0);
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

type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const validImageResult = {
    canceled: false,
    assets: [{
        uri: 'file:///picked-image.jpg',
        width: 120,
        height: 80,
        fileName: 'picked-image.jpg',
        fileSize: 1024,
        mimeType: 'image/jpeg',
    }],
};

const validMediaResult = {
    canceled: false,
    assets: [{
        uri: 'file:///picked-audio.m4a',
        name: 'picked-audio.m4a',
        size: 2048,
        mimeType: 'audio/mp4',
        lastModified: 0,
    }],
};

const validPdfResult = {
    canceled: false,
    assets: [{
        uri: 'file:///picked-document.pdf',
        name: 'picked-document.pdf',
        size: 4096,
        mimeType: 'application/pdf',
        lastModified: 0,
        file: { size: 4096 } as File,
    }],
};

describe('useImagePicker attachment lifecycle generations', () => {
    let current: ReturnType<typeof useImagePicker> | null = null;

    function Probe({ maxAttachments = MAX_IMAGES_PER_MESSAGE }: { maxAttachments?: number }) {
        const { images, setImages } = useComposeDraft();
        current = useImagePicker({
            maxAttachments,
            selection: {
                images,
                setImages,
                generation: composeDraftAttachmentSelectionGeneration,
            },
        });
        return null;
    }

    const lanes = [
        {
            name: 'image',
            pickerMock: () => vi.mocked(ImagePicker.launchImageLibraryAsync),
            result: validImageResult,
            pick: () => current!.pickImages().then(() => undefined),
        },
        {
            name: 'media',
            pickerMock: () => vi.mocked(DocumentPicker.getDocumentAsync),
            result: validMediaResult,
            pick: () => current!.pickMedia(),
        },
        {
            name: 'PDF',
            pickerMock: () => vi.mocked(DocumentPicker.getDocumentAsync),
            result: validPdfResult,
            pick: () => current!.pickPdf(),
        },
    ];

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        current = null;
        (Platform as { OS: string }).OS = 'web';
        useComposeDraft.setState({ text: '', revision: 0, images: [] });
        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockReset();
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
        vi.mocked(DocumentPicker.getDocumentAsync).mockReset();
        vi.mocked(getInfoAsync).mockReset();
        vi.mocked(normalizeImageForUpload).mockReset();
        vi.mocked(normalizeImageForUpload).mockResolvedValue({
            uri: 'file:///normalized-image.jpg',
            width: 120,
            height: 80,
            mimeType: 'image/jpeg',
            size: 1024,
        });
        vi.mocked(generateThumbhash).mockReset();
        vi.mocked(generateThumbhash).mockResolvedValue('thumbhash');
        vi.mocked(Modal.alert).mockReset();
    });

    it.each(lanes)('discards a late $name picker result after clearImages', async ({ pickerMock, result, pick }) => {
        const pending = deferred<any>();
        pickerMock().mockReturnValueOnce(pending.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<void>;
        await act(async () => {
            picking = pick();
            await Promise.resolve();
        });
        act(() => { current!.clearImages(); });
        pending.resolve(result);
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it.each(lanes)('discards a late $name picker result after external clearComposeDraft', async ({ pickerMock, result, pick }) => {
        const pending = deferred<any>();
        pickerMock().mockReturnValueOnce(pending.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<void>;
        await act(async () => {
            picking = pick();
            await Promise.resolve();
        });
        act(() => { clearComposeDraft(); });
        pending.resolve(result);
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it.each(lanes)('does not let an unmounted $name picker overwrite data from a newer hook instance', async ({ pickerMock, result, pick }) => {
        const pending = deferred<any>();
        pickerMock().mockReturnValueOnce(pending.promise);
        let oldRenderer: any;
        await act(async () => { oldRenderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<void>;
        await act(async () => {
            picking = pick();
            await Promise.resolve();
        });
        act(() => oldRenderer.unmount());

        let newRenderer: any;
        await act(async () => { newRenderer = TestRenderer.create(React.createElement(Probe)); });
        act(() => {
            current!.addImages([{
                id: 'new-instance-image',
                uri: 'file:///new-instance.jpg',
                width: 10,
                height: 10,
                mimeType: 'image/jpeg',
                size: 10,
                name: 'new-instance.jpg',
            }]);
        });

        pending.resolve(result);
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images.map((image) => image.id)).toEqual(['new-instance-image']);
        act(() => newRenderer.unmount());
    });

    it('checks invalidation after media-library permission resolves', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const permission = deferred<{ status: 'granted' }>();
        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockReturnValueOnce(permission.promise as any);
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(validImageResult as any);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<unknown>;
        act(() => { picking = current!.pickImages(); });
        act(() => { current!.clearImages(); });
        permission.resolve({ status: 'granted' });
        await act(async () => { await picking; });

        expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it('checks invalidation after image normalization resolves', async () => {
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(validImageResult as any);
        const normalization = deferred<any>();
        vi.mocked(normalizeImageForUpload).mockReturnValueOnce(normalization.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<unknown>;
        await act(async () => {
            picking = current!.pickImages();
            await vi.waitFor(() => expect(normalizeImageForUpload).toHaveBeenCalledOnce());
        });
        act(() => { current!.clearImages(); });
        normalization.resolve({
            uri: 'file:///normalized-image.jpg',
            width: 120,
            height: 80,
            mimeType: 'image/jpeg',
            size: 1024,
        });
        await act(async () => { await picking; });

        expect(generateThumbhash).not.toHaveBeenCalled();
        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it('checks invalidation after thumbhash generation resolves', async () => {
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(validImageResult as any);
        const thumbhash = deferred<string>();
        vi.mocked(generateThumbhash).mockReturnValueOnce(thumbhash.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<unknown>;
        await act(async () => {
            picking = current!.pickImages();
            await vi.waitFor(() => expect(generateThumbhash).toHaveBeenCalledOnce());
        });
        act(() => { current!.clearImages(); });
        thumbhash.resolve('late-thumbhash');
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it('checks invalidation after a delayed PDF stat resolves', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'file:///stat-document.pdf',
                name: 'stat-document.pdf',
                mimeType: 'application/pdf',
                lastModified: 0,
            }],
        });
        const stat = deferred<any>();
        vi.mocked(getInfoAsync).mockReturnValueOnce(stat.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<void>;
        await act(async () => {
            picking = current!.pickPdf();
            await vi.waitFor(() => expect(getInfoAsync).toHaveBeenCalledOnce());
        });
        act(() => { clearComposeDraft(); });
        stat.resolve({
            exists: true,
            isDirectory: false,
            uri: 'file:///stat-document.pdf',
            size: 4096,
            modificationTime: 0,
        });
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it('rechecks the generation inside a deferred functional setter', async () => {
        vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(validMediaResult as any);
        let queuedUpdate: ((images: any[]) => any[]) | null = null;

        function DeferredSetterProbe() {
            const images = useComposeDraft((state) => state.images);
            current = useImagePicker({
                selection: {
                    images,
                    setImages: (update) => {
                        if (typeof update === 'function') queuedUpdate = update;
                    },
                    generation: composeDraftAttachmentSelectionGeneration,
                },
            });
            return null;
        }

        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(DeferredSetterProbe)); });
        await act(async () => { await current!.pickMedia(); });
        expect(queuedUpdate).not.toBeNull();

        act(() => { clearComposeDraft(); });
        act(() => {
            useComposeDraft.setState((state) => ({
                images: queuedUpdate!(state.images),
            }));
        });

        expect(useComposeDraft.getState().images).toEqual([]);
        act(() => renderer.unmount());
    });

    it('keeps attachment selection valid across compose text edits', async () => {
        const pending = deferred<any>();
        vi.mocked(DocumentPicker.getDocumentAsync).mockReturnValueOnce(pending.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });

        let picking!: Promise<void>;
        act(() => { picking = current!.pickMedia(); });
        act(() => { useComposeDraft.getState().setText('new text'); });
        pending.resolve(validMediaResult);
        await act(async () => { await picking; });

        expect(useComposeDraft.getState().images.map((image) => image.name)).toEqual(['picked-audio.m4a']);
        act(() => renderer.unmount());
    });

    it('allows two concurrent selections to append under the existing cap', async () => {
        const mediaPending = deferred<any>();
        const pdfPending = deferred<any>();
        vi.mocked(DocumentPicker.getDocumentAsync)
            .mockReturnValueOnce(mediaPending.promise)
            .mockReturnValueOnce(pdfPending.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Probe, { maxAttachments: 2 })); });

        let pickingMedia!: Promise<void>;
        let pickingPdf!: Promise<void>;
        act(() => {
            pickingMedia = current!.pickMedia();
            pickingPdf = current!.pickPdf();
        });
        pdfPending.resolve(validPdfResult);
        await act(async () => { await pickingPdf; });
        mediaPending.resolve(validMediaResult);
        await act(async () => { await pickingMedia; });

        expect(useComposeDraft.getState().images.map((image) => image.name)).toEqual([
            'picked-document.pdf',
            'picked-audio.m4a',
        ]);
        act(() => renderer.unmount());
    });

    it('isolates picker tokens across StrictMode lifecycle replay', async () => {
        const beforeReplay = deferred<any>();
        const afterReplayResult = {
            canceled: false as const,
            assets: [{
                uri: 'file:///after-replay.m4a',
                name: 'after-replay.m4a',
                size: 1024,
                mimeType: 'audio/mp4',
                lastModified: 0,
            }],
        };
        vi.mocked(DocumentPicker.getDocumentAsync)
            .mockReturnValueOnce(beforeReplay.promise)
            .mockResolvedValueOnce(afterReplayResult);
        let beforeReplayPicking: Promise<void> | null = null;

        function StrictModeProbe() {
            const { images, setImages } = useComposeDraft();
            const picker = useImagePicker({
                selection: {
                    images,
                    setImages,
                    generation: composeDraftAttachmentSelectionGeneration,
                },
            });
            current = picker;
            const startedBeforeReplay = React.useRef(false);
            React.useEffect(() => {
                if (startedBeforeReplay.current) return;
                startedBeforeReplay.current = true;
                beforeReplayPicking = picker.pickMedia();
            }, [picker.pickMedia]);
            return null;
        }

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                React.createElement(React.StrictMode, null, React.createElement(StrictModeProbe)),
            );
        });
        expect(beforeReplayPicking).not.toBeNull();

        await act(async () => { await current!.pickMedia(); });
        expect(useComposeDraft.getState().images.map((image) => image.name)).toEqual(['after-replay.m4a']);

        beforeReplay.resolve(validMediaResult);
        await act(async () => { await beforeReplayPicking; });
        expect(useComposeDraft.getState().images.map((image) => image.name)).toEqual(['after-replay.m4a']);
        act(() => renderer.unmount());
    });
});
