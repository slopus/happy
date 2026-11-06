import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileView } from './FileView';
import { invalidateLocalHistorySession } from '@/sync/localHistoryStore';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    release: vi.fn(),
    openDocument: vi.fn(async () => undefined),
    downloadOriginal: vi.fn(async () => true),
    openImageViewer: vi.fn(),
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
vi.mock('@/sync/openSessionImageViewer', () => ({ openSessionImageViewer: mocks.openImageViewer }));
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

function audioTool(input: { encrypted?: boolean; source?: 'generated'; ref?: string; name?: string } = {}) {
    return {
        name: 'file',
        state: 'completed',
        input: {
            ref: 'sessions/s1/attachments/voice.mp3',
            name: 'voice.mp3',
            size: 4096,
            kind: 'audio',
            mimeType: 'audio/mpeg',
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
        mocks.openImageViewer.mockClear();
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

    it('renders a public MP4 URL through the same player without authenticated resolution', async () => {
        const tool = videoTool({ encrypted: false });
        tool.input.ref = 'https://public.test/shared/video';
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={tool} metadata={null} messages={[]} />,
            );
        });

        expect(mocks.resolveSource).not.toHaveBeenCalled();
        expect(renderer.root.findByType('MediaAttachmentPlayer').props).toMatchObject({
            uri: 'https://public.test/shared/video',
            kind: 'video',
            testID: 'media-attachment-player-user',
        });

        act(() => renderer.unmount());
    });

    it('resolves a fresh video source after attachment invalidation without using its stale refresh callback', async () => {
        const staleRefresh = vi.fn();
        const stillCurrent = () => true;
        mocks.resolveSource.mockResolvedValueOnce(Object.assign({
            uri: 'https://files.test/before.mp4', headers: {}, release: mocks.release,
        }, { reuseKey: 'before', refreshSource: staleRefresh, isCurrent: stillCurrent }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<FileView tool={videoTool({ encrypted: false })} sessionId="s1" metadata={null} messages={[]} />);
        });
        expect(renderer.root.findByType('MediaAttachmentPlayer').props.isSourceCurrent).toBe(stillCurrent);
        mocks.resolveSource.mockResolvedValueOnce(Object.assign({
            uri: 'https://files.test/after.mp4', headers: {}, release: mocks.release,
        }, { reuseKey: 'after' }));
        await act(async () => { invalidateLocalHistorySession('other-account-scope', 'other-session'); });
        expect(mocks.resolveSource).toHaveBeenCalledTimes(2);
        expect(staleRefresh).not.toHaveBeenCalled();
        expect(renderer.root.findByType('MediaAttachmentPlayer').props).toMatchObject({ uri: 'https://files.test/after.mp4', reuseKey: 'after' });
        act(() => renderer.unmount());
    });

    it('does not resurrect an old video when its async resolution completes after invalidation', async () => {
        let resolveOld!: (source: { uri: string; headers: {}; release: typeof mocks.release }) => void;
        mocks.resolveSource.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
        const releaseOld = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<FileView tool={videoTool({ encrypted: false })} sessionId="s1" metadata={null} messages={[]} />);
        });
        mocks.resolveSource.mockResolvedValueOnce({ uri: 'https://files.test/fresh.mp4', headers: {}, release: mocks.release });
        await act(async () => { invalidateLocalHistorySession('scope', 'deleted'); });
        await act(async () => { resolveOld({ uri: 'https://files.test/stale.mp4', headers: {}, release: releaseOld }); });
        expect(mocks.resolveSource).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByType('MediaAttachmentPlayer').props.uri).toBe('https://files.test/fresh.mp4');
        expect(releaseOld).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('clears an existing video if new credentials are unavailable after invalidation', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<FileView tool={videoTool({ encrypted: false })} sessionId="s1" metadata={null} messages={[]} />);
        });
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(1);
        mocks.resolveSource.mockRejectedValueOnce(new Error('Attachment credentials are unavailable'));
        await act(async () => { invalidateLocalHistorySession('scope', 'logout'); });
        expect(mocks.resolveSource).toHaveBeenCalledTimes(2);
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(0);
        expect(mocks.release).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('resolves generated audio only after its compact play control is pressed', async () => {
        mocks.resolveSource.mockResolvedValueOnce({
            uri: 'https://files.test/voice.mp3',
            headers: {},
            release: mocks.release,
        });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={audioTool({ encrypted: false, source: 'generated' })} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        expect(mocks.resolveSource).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: 'media-attachment-card-generated' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(0);

        const play = renderer.root.findByProps({ testID: 'media-attachment-play-generated' });
        await act(async () => { await play.props.onPress(); });

        expect(mocks.resolveSource).toHaveBeenCalledOnce();
        expect(mocks.resolveSource).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            mimeType: 'audio/mpeg',
            encrypted: false,
        }));
        expect(renderer.root.findByProps({ testID: 'media-attachment-inline-generated' })).toBeTruthy();
        expect(renderer.root.findByType('MediaAttachmentPlayer').props).toMatchObject({
            uri: 'https://files.test/voice.mp3',
            title: 'voice.mp3',
            kind: 'audio',
            mimeType: 'audio/mpeg',
            testID: 'media-attachment-player-generated',
            autoPlay: true,
        });

        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('shows a retryable compact state when audio resolution fails', async () => {
        mocks.resolveSource
            .mockRejectedValueOnce(new Error('download failed'))
            .mockResolvedValueOnce({
                uri: 'https://files.test/voice-retry.mp3',
                headers: {},
                release: mocks.release,
            });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={audioTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });

        let play = renderer.root.findByProps({ testID: 'media-attachment-play-user' });
        await act(async () => { await play.props.onPress(); });

        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(renderer.root.findByType('Ionicons').props.name).toBe('refresh-circle');
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'media-attachment-play-user' }).props.disabled).toBe(false);

        play = renderer.root.findByProps({ testID: 'media-attachment-play-user' });
        await act(async () => { await play.props.onPress(); });

        expect(mocks.resolveSource).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByType('MediaAttachmentPlayer').props).toMatchObject({
            uri: 'https://files.test/voice-retry.mp3',
            autoPlay: true,
        });

        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('releases active audio and returns to idle when attachment identity changes', async () => {
        mocks.resolveSource.mockResolvedValueOnce({
            uri: 'https://files.test/voice.mp3',
            headers: {},
            release: mocks.release,
        });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={audioTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'media-attachment-play-user' }).props.onPress();
        });

        await act(async () => {
            renderer.update(
                <FileView
                    tool={audioTool({ ref: 'sessions/s1/attachments/other.mp3', name: 'other.mp3' })}
                    sessionId="s1"
                    metadata={null}
                    messages={[]}
                />,
            );
        });

        expect(mocks.release).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'media-attachment-play-user' })).toBeTruthy();
        expect(mocks.resolveSource).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('releases a late audio result after attachment identity changes without rendering it', async () => {
        let resolvePending!: (source: { uri: string; headers: {}; release: typeof mocks.release }) => void;
        mocks.resolveSource.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePending = resolve;
        }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={audioTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });
        act(() => {
            void renderer.root.findByProps({ testID: 'media-attachment-play-user' }).props.onPress();
        });

        await act(async () => {
            renderer.update(
                <FileView
                    tool={audioTool({ ref: 'sessions/s1/attachments/other.mp3', name: 'other.mp3' })}
                    sessionId="s1"
                    metadata={null}
                    messages={[]}
                />,
            );
        });
        await act(async () => {
            resolvePending({ uri: 'https://files.test/stale.mp3', headers: {}, release: mocks.release });
            await Promise.resolve();
        });

        expect(mocks.release).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByType('MediaAttachmentPlayer')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'media-attachment-play-user' })).toBeTruthy();

        act(() => renderer.unmount());
    });

    it('releases a late audio result after unmount without updating the tree', async () => {
        let resolvePending!: (source: { uri: string; headers: {}; release: typeof mocks.release }) => void;
        mocks.resolveSource.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePending = resolve;
        }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <FileView tool={audioTool()} sessionId="s1" metadata={null} messages={[]} />,
            );
        });
        act(() => {
            void renderer.root.findByProps({ testID: 'media-attachment-play-user' }).props.onPress();
        });
        act(() => renderer.unmount());

        await act(async () => {
            resolvePending({ uri: 'https://files.test/stale.mp3', headers: {}, release: mocks.release });
            await Promise.resolve();
        });

        expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('lets a modal host open the original image without a sibling native Modal', async () => {
        const onOpenImage = vi.fn();
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<FileView tool={{
            name: 'file', state: 'completed', input: { kind: 'image', ref: 'original.png', name: '原图.png' },
        } as any} sessionId="s1" metadata={null} messages={[]} onOpenImage={onOpenImage} />); });
        act(() => renderer.root.findByProps({ accessibilityLabel: '原图.png' }).props.onPress());
        expect(onOpenImage).toHaveBeenCalledWith(expect.objectContaining({ uri: 'data:image/jpeg;base64,AA==', attachmentRef: 'original.png', sessionId: 's1' }));
        expect(mocks.openImageViewer).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });

    it('opens a motion-photo cover as a still image in the fullscreen viewer', async () => {
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

        expect(mocks.resolveMotionSource).not.toHaveBeenCalled();
        expect(mocks.openImageViewer).toHaveBeenCalledWith({
            uri: 'data:image/jpeg;base64,AA==',
            width: 1080,
            height: 1920,
            filename: 'photo.jpg',
            sessionId: 's1',
            attachmentRef: 'sessions/s1/attachments/photo.enc',
            motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
        });

        act(() => renderer.unmount());
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

    it('opens a historical detected motion photo in the fullscreen viewer', async () => {
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
        expect(mocks.resolveMotionSource).not.toHaveBeenCalled();
        expect(mocks.openImageViewer).toHaveBeenCalledWith(expect.objectContaining({
            attachmentRef: 'historical.enc',
            motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' },
        }));
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
