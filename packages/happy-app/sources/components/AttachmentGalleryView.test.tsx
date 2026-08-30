import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create, find and unmount.
import TestRenderer from 'react-test-renderer';

import { AttachmentGalleryView } from './AttachmentGalleryView';
import type { ToolCallMessage } from '@/sync/typesMessage';

const attachmentImages = vi.hoisted(() => new Map<string, {
    uri: string | null;
    loading: boolean;
    error: string | null;
}>());

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 360, height: 800 }),
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: {
                divider: '#333333',
                surfaceHigh: '#222222',
                text: '#ffffff',
                textSecondary: '#888888',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333333',
                surfaceHigh: '#222222',
                text: '#ffffff',
                textSecondary: '#888888',
            },
        },
    }),
}));
vi.mock('@/hooks/useAttachmentImage', () => ({
    useAttachmentImage: (_sessionId: string, ref: string | undefined) => ref
        ? attachmentImages.get(ref) ?? { uri: null, loading: true, error: null }
        : { uri: null, loading: false, error: null },
}));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: () => undefined }));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/components/HorizontalScrollView', () => ({ HorizontalScrollView: 'HorizontalScrollView' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, number>) => {
        switch (key) {
            case 'generatedImageBatchDownload.generating':
                return `Generating ${params?.completed}/${params?.total}`;
            case 'generatedImageBatchDownload.preparing':
                return `Preparing ${params?.ready}/${params?.total}`;
            case 'generatedImageBatchDownload.downloadAll':
                return `Download all ${params?.count}`;
            case 'generatedImageBatchDownload.downloading':
                return `Downloading ${params?.completed}/${params?.total}`;
            case 'generatedImageBatchDownload.saved':
                return `Saved ${params?.count}`;
            case 'generatedImageBatchDownload.partial':
                return `Saved ${params?.succeeded}; ${params?.failed} failed`;
            case 'generatedImageBatchDownload.retryFailed':
                return `Retry ${params?.count}`;
            default:
                return key;
        }
    },
}));

function generatedImageMessage(index = 1, ref = `ref-generated-${index}`): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: `generated-${index}`,
        localId: null,
        createdAt: index,
        tool: {
            name: 'file',
            state: 'completed',
            input: {
                ref,
                name: `generated-${index}.png`,
                source: 'generated',
                batchId: 'batch-56',
                image: { width: 1024, height: 1536 },
            },
            createdAt: index,
            startedAt: index,
            completedAt: index + 1,
            description: 'generated image',
        },
        children: [],
    };
}

function uploadedImageMessage(index = 1, ref = `ref-uploaded-${index}`): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: `uploaded-${index}`,
        localId: null,
        createdAt: index,
        tool: {
            name: 'file',
            state: 'completed',
            input: {
                ref,
                name: `uploaded-${index}.png`,
                kind: 'image',
                image: { width: 1024, height: 1536 },
            },
            createdAt: index,
            startedAt: index,
            completedAt: index + 1,
            description: 'uploaded image',
        },
        children: [],
    };
}

function uploadedAudioMessage(index = 1, ref = `ref-uploaded-audio-${index}`): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: `uploaded-audio-${index}`,
        localId: null,
        createdAt: index,
        tool: {
            name: 'file',
            state: 'completed',
            input: {
                ref,
                name: `uploaded-audio-${index}.m4a`,
                kind: 'audio',
            },
            createdAt: index,
            startedAt: index,
            completedAt: index + 1,
            description: 'uploaded audio',
        },
        children: [],
    };
}

describe('AttachmentGalleryView generated batches', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        attachmentImages.clear();
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('renders incremental generated results in a bounded grid with visible batch loading', () => {
        attachmentImages.set('ref-generated-1', {
            uri: 'blob:generated-image-1',
            loading: false,
            error: null,
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[generatedImageMessage()]}
                    sessionId="session-1"
                    presentation="generated-grid"
                    pendingCount={55}
                    pendingStartedAt={Date.now() - 2_000}
                />,
            );
        });

        expect(renderer.root.findAllByType('HorizontalScrollView')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-grid' })).toBeTruthy();
        expect(renderer.root.findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
        const progressText = renderer.root
            .findAllByType('Text')
            .map((node: any) => node.children.join(''))
            .find((text: string) => text.includes('1/56'));
        expect(progressText).toBe('Generating 1/56');

        act(() => renderer.unmount());
    });

    it('renders a disabled batch action while generated images are pending', () => {
        attachmentImages.set('ref-generated-1', {
            uri: 'blob:generated-image-1',
            loading: false,
            error: null,
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[generatedImageMessage()]}
                    sessionId="session-1"
                    presentation="generated-grid"
                    pendingCount={55}
                />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(true);

        act(() => renderer.unmount());
    });

    it('enables the batch action after all attachment refs resolve and pending reaches zero', () => {
        const messages = [generatedImageMessage(1), generatedImageMessage(2)];
        attachmentImages.set('ref-generated-1', { uri: null, loading: true, error: null });
        attachmentImages.set('ref-generated-2', { uri: null, loading: true, error: null });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={messages}
                    sessionId="session-1"
                    presentation="generated-grid"
                    pendingCount={1}
                />,
            );
        });

        attachmentImages.set('ref-generated-1', { uri: 'blob:generated-image-1', loading: false, error: null });
        attachmentImages.set('ref-generated-2', { uri: 'blob:generated-image-2', loading: false, error: null });
        act(() => {
            renderer.update(
                <AttachmentGalleryView
                    messages={[...messages]}
                    sessionId="session-1"
                    presentation="generated-grid"
                    pendingCount={0}
                />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(false);

        act(() => renderer.unmount());
    });

    it('counts a resolution error as settled without blocking successful image downloads', () => {
        attachmentImages.set('ref-generated-1', {
            uri: 'blob:generated-image-1',
            loading: false,
            error: null,
        });
        attachmentImages.set('ref-generated-2', {
            uri: null,
            loading: false,
            error: 'resolution failed',
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[generatedImageMessage(1), generatedImageMessage(2)]}
                    sessionId="session-1"
                    presentation="generated-grid"
                    pendingCount={0}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.disabled).toBe(false);
        expect(button.findByType('Text').children.join('')).toContain('1');

        act(() => renderer.unmount());
    });

    it('hides the batch action for one resolved direct data image', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[generatedImageMessage(1, 'data:image/png;base64,AA==')]}
                    sessionId=""
                    presentation="generated-grid"
                    pendingCount={0}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'attachment-gallery-download-all' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('renders a public image URL without an authenticated session', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[uploadedImageMessage(1, 'https://public.test/shared/image')]}
                    presentation="compact"
                />,
            );
        });

        expect(renderer.root.findByType('Image').props.source).toEqual({
            uri: 'https://public.test/shared/image',
        });
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-image' }).props.disabled).toBe(false);

        act(() => renderer.unmount());
    });

    it.each(['compact', 'featured'] as const)('renders a batch action for multiple images in %s galleries', (presentation) => {
        attachmentImages.set('ref-uploaded-1', {
            uri: 'blob:uploaded-image-1',
            loading: false,
            error: null,
        });
        attachmentImages.set('ref-uploaded-2', {
            uri: 'blob:uploaded-image-2',
            loading: false,
            error: null,
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[uploadedImageMessage(1), uploadedImageMessage(2)]}
                    sessionId="session-1"
                    presentation={presentation}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.disabled).toBe(false);
        expect(button.findByType('Text').children.join('')).toBe('Download all 2');

        act(() => renderer.unmount());
    });

    it('keeps ordinary gallery downloads disabled until every image settles', () => {
        attachmentImages.set('ref-uploaded-1', { uri: 'blob:uploaded-image-1', loading: false, error: null });
        attachmentImages.set('ref-uploaded-2', { uri: null, loading: true, error: null });
        const messages = [uploadedImageMessage(1), uploadedImageMessage(2)];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView messages={messages} sessionId="session-1" presentation="compact" />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(true);

        attachmentImages.set('ref-uploaded-2', { uri: 'blob:uploaded-image-2', loading: false, error: null });
        act(() => {
            renderer.update(
                <AttachmentGalleryView messages={[...messages]} sessionId="session-1" presentation="compact" />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(false);

        act(() => renderer.unmount());
    });

    it('does not let non-image attachments block ordinary gallery downloads', () => {
        attachmentImages.set('ref-uploaded-1', { uri: 'blob:uploaded-image-1', loading: false, error: null });
        attachmentImages.set('ref-uploaded-2', { uri: 'blob:uploaded-image-2', loading: false, error: null });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[uploadedImageMessage(1), uploadedAudioMessage(), uploadedImageMessage(2)]}
                    sessionId="session-1"
                    presentation="compact"
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.disabled).toBe(false);
        expect(button.findByType('Text').children.join('')).toBe('Download all 2');

        act(() => renderer.unmount());
    });

    it.each(['compact', 'featured'] as const)('does not render a batch action for one image in %s galleries', (presentation) => {
        attachmentImages.set('ref-uploaded-1', {
            uri: 'blob:uploaded-image-1',
            loading: false,
            error: null,
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentGalleryView
                    messages={[uploadedImageMessage()]}
                    sessionId="session-1"
                    presentation={presentation}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'attachment-gallery-download-all' })).toHaveLength(0);

        act(() => renderer.unmount());
    });
});
