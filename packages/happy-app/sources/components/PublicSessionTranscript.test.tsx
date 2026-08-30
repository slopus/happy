import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    FlatList: 'FlatList',
    Image: 'Image',
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/text/publicSessionShareText', () => ({ publicSessionShareText: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn() } }));
vi.mock('@/hooks/useGroupedMessages', () => ({
    useGroupedMessages: (messages: any[]) => messages.map((message) => ({
        type: 'message',
        id: message.id,
        message,
    })),
}));
vi.mock('@/hooks/useUserMessageAnchors', () => ({ useUserMessageAnchors: () => [] }));
vi.mock('@/utils/messageForkPoint', () => ({ getAgentMessageForkTargets: () => new Map() }));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
}));
vi.mock('./MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./ToolGroupView', () => ({ AgentWorkGroupView: 'AgentWorkGroupView', ToolGroupView: 'ToolGroupView' }));
vi.mock('./AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('./AnchorListSheet', () => ({ AnchorListSheet: 'AnchorListSheet' }));
const { theme } = vi.hoisted(() => ({ theme: {
    colors: {
        accent: '#08f', divider: '#444', surface: '#181818', surfaceHigh: '#222',
        text: '#fff', textSecondary: '#aaa', status: { connected: '#0f0', error: '#f00' },
        groupped: { background: '#111' }, input: { background: '#222' },
        shadow: { color: '#000', opacity: 0.2 },
    },
} }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory(theme),
    },
}));

import { PublicSessionTranscript } from './PublicSessionTranscript';

const snapshot = {
    version: 1 as const,
    title: 'Launch review',
    sharedAt: 1_788_000_000_000,
    messages: [
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
        { id: 'user-1', role: 'user' as const, createdAt: 1, blocks: [{ type: 'text' as const, markdown: 'Please review **this**.' }] },
    ],
};

describe('PublicSessionTranscript', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('adapts the public snapshot to read-only conversation messages', () => {
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
        const transcript = renderer.root.findByProps({ testID: 'conversation-transcript-list' });
        const messages = transcript.props.data.map((item: any) => item.message);
        expect(messages[0]).toMatchObject({ kind: 'user-text', text: 'Please review **this**.' });
        expect(messages[1]).toMatchObject({ kind: 'agent-text', text: 'Looks good.' });
        expect(messages.some((message: any) => message?.kind === 'user-text' && message.text === 'Please review **this**.')).toBe(true);
        expect(messages.some((message: any) => message?.kind === 'agent-text' && message.text === 'Looks good.')).toBe(true);
        expect(messages.filter((message: any) => message?.kind === 'tool-call' && message.tool.name === 'file')).toHaveLength(4);
        expect(messages.find((message: any) => message?.tool?.input?.name === 'preview.png').tool.input.ref)
            .toContain('/v1/public/session-shares/public-id/attachments/asset-1');
        expect(renderer.root.findAllByProps({ testID: 'message-composer' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-left-sidebar' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('routes snapshot messages through the shared virtualized conversation transcript', () => {
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

        const transcriptLists = renderer.root.findAllByProps({ testID: 'conversation-transcript-list' });
        expect(transcriptLists).toHaveLength(1);
        expect(transcriptLists[0].props.inverted).toBe(false);
        expect(transcriptLists[0].props.data.some((item: any) => item.message?.kind === 'user-text')).toBe(true);
        expect(transcriptLists[0].props.data.some((item: any) => item.message?.kind === 'agent-text')).toBe(true);

        act(() => renderer.unmount());
    });
});
