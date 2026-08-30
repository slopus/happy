import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Image: 'Image',
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/text/publicSessionShareText', () => ({ publicSessionShareText: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                accent: '#08f', divider: '#444', surface: '#181818', surfaceHigh: '#222',
                text: '#fff', textSecondary: '#aaa', status: { connected: '#0f0', error: '#f00' },
                groupped: { background: '#111' }, input: { background: '#222' },
            },
        }),
    },
}));

import { PublicSessionTranscript } from './PublicSessionTranscript';

const snapshot = {
    version: 1 as const,
    title: 'Launch review',
    sharedAt: 1_788_000_000_000,
    messages: [
        { id: 'user-1', role: 'user' as const, createdAt: 1, blocks: [{ type: 'text' as const, markdown: 'Please review **this**.' }] },
        {
            id: 'assistant-1', role: 'assistant' as const, createdAt: 2,
            blocks: [
                { type: 'text' as const, markdown: 'Looks good.' },
                { type: 'attachment' as const, attachmentId: 'asset-1', kind: 'image' as const, name: 'preview.png', mimeType: 'image/png', size: 42 },
                { type: 'attachment' as const, attachmentId: 'asset-2', kind: 'audio' as const, name: 'note.m4a', mimeType: 'audio/mp4', size: 43 },
                { type: 'attachment' as const, attachmentId: 'asset-3', kind: 'video' as const, name: 'demo.mp4', mimeType: 'video/mp4', size: 44 },
                { type: 'attachment' as const, attachmentId: 'asset-4', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', size: 45 },
            ],
        },
    ],
};

describe('PublicSessionTranscript', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('renders only the read-only snapshot and public attachment URLs', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    publicId="public-id"
                    publishedAt={snapshot.sharedAt}
                    snapshot={snapshot}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'public-session-transcript' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'public-session-message-user-1' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'public-session-message-assistant-1' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'public-session-attachment-asset-1' }).props.source.uri)
            .toContain('/v1/public/session-shares/public-id/attachments/asset-1');
        expect(renderer.root.findByProps({ 'data-testid': 'public-session-attachment-asset-2' }).type).toBe('audio');
        expect(renderer.root.findByProps({ 'data-testid': 'public-session-attachment-asset-3' }).type).toBe('video');
        expect(renderer.root.findAllByProps({ testID: 'public-session-attachment-asset-4' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'message-composer' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-left-sidebar' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);

        act(() => renderer.root.findByProps({ testID: 'public-session-attachment-asset-1' }).props.onError());
        expect(renderer.root.findAllByProps({ testID: 'public-session-attachment-unavailable-asset-1' })).toHaveLength(1);

        act(() => renderer.unmount());
    });
});
