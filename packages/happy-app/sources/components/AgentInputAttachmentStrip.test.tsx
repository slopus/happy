import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    openImageViewer: vi.fn(),
}));

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: (theme: any) => object) => factory({}) },
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333',
                surfaceHigh: '#222',
                text: '#fff',
                textSecondary: '#aaa',
            },
        },
    }),
}));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: () => null }));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: mocks.openImageViewer } }));
vi.mock('@/components/HorizontalScrollView', () => ({ HorizontalScrollView: 'HorizontalScrollView' }));
vi.mock('@/utils/attachmentGalleryLayout', () => ({
    computeInputAttachmentImageSize: () => ({ width: 72, height: 72 }),
}));
vi.mock('@/components/tools/views/MediaAttachmentPlayer', () => ({ MediaAttachmentPlayer: 'MediaAttachmentPlayer' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('AgentInputAttachmentStrip mixed attachments', () => {
    it('opens only image attachments when the pending strip also contains a PDF', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.openImageViewer.mockClear();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AgentInputAttachmentStrip
                    images={[
                        {
                            id: 'image-1',
                            uri: 'file:///tmp/reference.png',
                            width: 640,
                            height: 480,
                            mimeType: 'image/png',
                            size: 1024,
                            name: 'reference.png',
                        },
                        {
                            id: 'pdf-1',
                            uri: 'file:///tmp/floor-plan.pdf',
                            width: 0,
                            height: 0,
                            mimeType: 'application/pdf',
                            size: 2048,
                            name: 'floor-plan.pdf',
                            kind: 'file',
                        },
                    ]}
                    onRemove={vi.fn()}
                />,
            );
        });

        const image = renderer.root.findByType('Image');
        act(() => image.parent?.props.onPress());

        expect(mocks.openImageViewer).toHaveBeenCalledWith([
            {
                uri: 'file:///tmp/reference.png',
                width: 640,
                height: 480,
                filename: 'reference.png',
            },
        ], 0);
        act(() => renderer.unmount());
    });
});
