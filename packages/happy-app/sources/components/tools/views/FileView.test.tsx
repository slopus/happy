import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileView } from './FileView';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    release: vi.fn(),
    openDocument: vi.fn(async () => undefined),
    downloadOriginal: vi.fn(async () => true),
    resolveSource: vi.fn(async () => ({
        uri: 'https://files.test/acceptance.mp4',
        headers: {},
        release: mocks.release,
    })),
    resolveMotionSource: vi.fn(async () => ({
        uri: 'file:///cache/photo.jpg.mp4',
        headers: {},
        release: mocks.release,
    })),
    attachmentImageState: { uri: 'data:image/jpeg;base64,AA==', error: null } as {
        uri: string | null;
        error: string | null;
        motionPhoto?: { videoOffset: number; videoLength: number; mimeType: 'video/mp4' };
    },
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: () => mocks.attachmentImageState }));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: () => null }));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/sync/resolveMediaAttachmentSource', () => ({ resolveMediaAttachmentSource: mocks.resolveSource }));
vi.mock('@/sync/resolveMotionPhotoAttachmentSource', () => ({ resolveMotionPhotoAttachmentSource: mocks.resolveMotionSource }));
vi.mock('@/sync/openDocumentAttachment', () => ({ openDocumentAttachment: mocks.openDocument }));
vi.mock('@/sync/downloadOriginalAttachment', () => ({ downloadOriginalAttachment: mocks.downloadOriginal }));
vi.mock('./MediaAttachmentPlayer', () => ({ MediaAttachmentPlayer: 'MediaAttachmentPlayer' }));
vi.mock('@/components/DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('@/text', () => ({
    t: (key: string, params?: { name?: string }) => `${key}:${params?.name ?? ''}`,
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#333',
            surfaceHigh: '#222',
            surface: '#111',
            surfacePressed: '#333',
            text: '#fff',
            textSecondary: '#aaa',
            textDestructive: '#f44',
            button: { primary: { tint: '#fff' } },
        },
    };
    return {
        StyleSheet: { create: (factory: (value: any) => object) => factory(theme) },
        useUnistyles: () => ({ theme }),
    };
});

function videoTool(input: { encrypted?: boolean; source?: 'generated' } = {}) {
    return {
        name: 'file',
        state: 'completed',
        input: {
            ref: 'sessions/s1/attachments/acceptance.mp4',
            name: 'acceptance.mp4',
            size: 4096,
            kind: 'video',
            mimeType: 'video/mp4',
            ...input,
        },
    } as any;
}

function pdfTool(input: { size?: number } = {}) {
    return {
        name: 'file',
        state: 'completed',
        input: {
            ref: 'sessions/s1/attachments/floor-plan.enc',
            name: 'floor-plan.pdf',
            size: 4096,
            kind: 'file',
            mimeType: 'application/pdf',
            ...input,
        },
    } as any;
}

describe('FileView media playback', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.release.mockClear();
        mocks.openDocument.mockClear();
        mocks.downloadOriginal.mockClear();
        mocks.resolveSource.mockReset();
        mocks.resolveSource.mockResolvedValue({
            uri: 'https://files.test/acceptance.mp4',
            headers: {},
            release: mocks.release,
        });
        mocks.resolveMotionSource.mockClear();
        mocks.attachmentImageState = { uri: 'data:image/jpeg;base64,AA==', error: null };
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => consoleWarnSpy.mockRestore());

    it('renders a generated plaintext MP4 directly without a file card', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={videoTool({ encrypted: false, source: 'generated' })} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        expect(mocks.resolveSource).toHaveBeenCalledWith(expect.objectContaining({ encrypted: false }));
        expect(renderer.root.findAllByProps({ testID: 'media-attachment-card-generated' })).toHaveLength(0);
        expect(renderer.root.findByType('MediaAttachmentPlayer').props).toMatchObject({
            uri: 'https://files.test/acceptance.mp4',
            kind: 'video',
            testID: 'media-attachment-player-generated',
        });

        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('renders an encrypted user MP4 directly through the same player component', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={videoTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        expect(mocks.resolveSource).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            encrypted: undefined,
            mimeType: 'video/mp4',
        }));
        expect(renderer.root.findAllByProps({ testID: 'media-attachment-card-user' })).toHaveLength(0);
        expect(renderer.root.findByType('MediaAttachmentPlayer').props.testID).toBe('media-attachment-player-user');
        act(() => renderer.unmount());
    });

    it('shows a motion-photo cover and extracts its embedded MP4 on press', async () => {
        const tool = {
            name: 'file',
            state: 'completed',
            input: {
                ref: 'sessions/s1/attachments/photo.enc',
                name: 'photo.jpg',
                size: 4096,
                image: { width: 1080, height: 1920 },
                motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
            },
        } as any;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        const cover = renderer.root.findByProps({ testID: 'motion-photo-cover' });
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-player' })).toHaveLength(0);
        await act(async () => { cover.props.onPress(); });

        expect(mocks.resolveMotionSource).toHaveBeenCalledWith({
            sessionId: 's1',
            ref: 'sessions/s1/attachments/photo.enc',
            fileName: 'photo.jpg',
        });
        expect(renderer.root.findByProps({ testID: 'motion-photo-player' }).props).toMatchObject({
            uri: 'file:///cache/photo.jpg.mp4',
            kind: 'video',
            aspectRatio: 1080 / 1920,
        });

        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('downloads the complete original motion JPEG without using its preview URI', async () => {
        mocks.resolveSource.mockResolvedValueOnce({
            uri: 'file:///cache/photo.jpg',
            headers: {},
            release: mocks.release,
        });
        const tool = {
            name: 'file',
            state: 'completed',
            input: {
                ref: 'sessions/s1/attachments/photo.enc',
                name: 'photo.jpg',
                size: 4096,
                image: { width: 1080, height: 1920 },
                motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
            },
        } as any;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        const download = renderer.root.findByProps({ testID: 'motion-photo-download' });
        await act(async () => { await download.props.onPress(); });

        expect(mocks.resolveSource).toHaveBeenCalledWith({
            sessionId: 's1',
            ref: 'sessions/s1/attachments/photo.enc',
            mimeType: 'image/jpeg',
            fileName: 'photo.jpg',
        });
        expect(mocks.downloadOriginal).toHaveBeenCalledWith(
            'file:///cache/photo.jpg',
            'photo.jpg',
            'image/jpeg',
        );
        expect(mocks.release).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('does not show the original-file download action for an ordinary image', async () => {
        const tool = {
            name: 'file',
            state: 'completed',
            input: {
                ref: 'sessions/s1/attachments/still.enc',
                name: 'still.jpg',
                size: 4096,
                image: { width: 1080, height: 1920 },
            },
        } as any;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'motion-photo-download' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-download-tooltip' })).toHaveLength(0);
        expect(renderer.root.findAll((node: any) => node.type === 'View' && node.props.style?.some?.((style: any) => style?.minHeight === 32))).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('shows the original-download tooltip on hover and keyboard focus', async () => {
        const tool = {
            name: 'file', state: 'completed',
            input: {
                ref: 'motion.enc', name: 'motion.jpg', size: 4096,
                image: { width: 1080, height: 1920 },
                motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
            },
        } as any;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} sessionId="s1" metadata={null} messages={[]} />,
            );
        });
        const button = renderer.root.findByProps({ testID: 'motion-photo-download' });
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(false);
        act(() => button.props.onHoverIn());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(true);
        act(() => button.props.onFocus());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(true);
        act(() => button.props.onHoverOut());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(true);
        act(() => button.props.onBlur());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(false);
        act(() => button.props.onHoverIn());
        act(() => button.props.onFocus());
        act(() => button.props.onBlur());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(true);
        act(() => button.props.onHoverOut());
        expect(renderer.root.findByProps({ testID: 'motion-photo-download-tooltip' }).props.visible).toBe(false);
        act(() => renderer.unmount());
    });

    it('plays a historical motion photo detected from its decrypted JPEG bytes', async () => {
        mocks.attachmentImageState = {
            uri: 'data:image/jpeg;base64,AA==',
            error: null,
            motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
        };
        const tool = {
            name: 'file', state: 'completed',
            input: { ref: 'historical.enc', name: 'historical.jpg', size: 4096, image: { width: 1080, height: 1920 } },
        } as any;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        const cover = renderer.root.findByProps({ testID: 'motion-photo-cover' });
        await act(async () => { cover.props.onPress(); });
        expect(renderer.root.findByProps({ testID: 'motion-photo-player' })).toBeDefined();
        act(() => renderer.unmount());
    });

    it('renders an encrypted PDF as a document card and shares the decrypted file on press', async () => {
        mocks.resolveSource.mockResolvedValueOnce({
            uri: 'file:///tmp/floor-plan.pdf',
            headers: {},
            release: mocks.release,
        });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={pdfTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        const card = renderer.root.findByProps({ testID: 'document-attachment-card-user' });
        expect(mocks.resolveSource).not.toHaveBeenCalled();

        await act(async () => {
            await card.props.onPress();
        });

        expect(mocks.resolveSource).toHaveBeenCalledWith({
            sessionId: 's1',
            ref: 'sessions/s1/attachments/floor-plan.enc',
            mimeType: 'application/pdf',
            fileName: 'floor-plan.pdf',
            encrypted: undefined,
        });
        expect(mocks.openDocument).toHaveBeenCalledWith(
            'file:///tmp/floor-plan.pdf',
            'floor-plan.pdf',
            'application/pdf',
        );
        expect(mocks.release).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('does not decrypt a historical PDF above the safe whole-buffer limit', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={pdfTool({ size: 11 * 1024 * 1024 })} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        const card = renderer.root.findByProps({ testID: 'document-attachment-card-user' });
        await act(async () => {
            await card.props.onPress();
        });

        expect(mocks.resolveSource).not.toHaveBeenCalled();
        expect(mocks.openDocument).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Text').some((node: any) => (
            node.props.children === 'imageUpload.documentOpenFailed:'
        ))).toBe(true);
        act(() => renderer.unmount());
    });
});
