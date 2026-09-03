import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ openURL: vi.fn() }));

vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    FlatList: 'FlatList',
    Image: 'Image',
    Linking: { openURL: mocks.openURL },
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
        surfaceHighest: '#292929', surfacePressed: '#242424', surfaceSelected: '#303030',
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
import { ConversationTranscript } from './ConversationTranscript';

const snapshot = {
    version: 1 as const,
    title: 'Launch review',
    sharedAt: 1_788_000_000_000,
    source: { provider: 'codex' as const },
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

const coveredSnapshot = {
    ...snapshot,
    version: 2 as const,
    appearance: {
        themePack: 'gingham' as const,
        cover: {
            assetId: '51515151-5151-4515-8515-515151515151',
            mimeType: 'image/webp' as const,
            size: 4321,
            width: 2400,
            height: 900,
            attribution: {
                photoId: 731889,
                photographer: 'Pavel Danilyuk',
                photographerUrl: 'https://www.pexels.com/@pavel-danilyuk/',
                photoUrl: 'https://www.pexels.com/photo/731889/',
            },
        },
    },
};
const defaultAppearanceProps = {
    appearanceMode: 'system' as const,
    onAppearanceModeChange: () => undefined,
};

describe('PublicSessionTranscript', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
                    {...defaultAppearanceProps}
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
        expect(renderer.root.findAllByProps({ testID: 'public-session-source-label' })[0].props.children).toBe('Codex');

        act(() => renderer.unmount());
    });

    it('routes snapshot messages through the shared virtualized conversation transcript', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    {...defaultAppearanceProps}
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

    it('presents a restrained document header with semantic title and page-sparkles artwork', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    {...defaultAppearanceProps}
                    publicId="public-id"
                    publishedAt={snapshot.sharedAt}
                    snapshot={snapshot}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'public-session-header-inner' })).toHaveLength(1);
        const title = renderer.root.findByProps({ testID: 'public-session-title' });
        expect(title.props.accessibilityRole).toBe('header');
        expect(title.props.style).toMatchObject({ fontSize: 22, lineHeight: 28, fontWeight: '600' });
        const icons = renderer.root.findAllByType('Ionicons').map((icon: any) => icon.props.name);
        expect(icons).toContain('document-text-outline');
        expect(icons).toContain('sparkles-outline');
        expect(icons).toContain('time-outline');
        expect(icons).not.toContain('chatbubble-ellipses-outline');
        expect(renderer.root.findByProps({ testID: 'public-session-header-mark' }).props.style)
            .not.toHaveProperty('backgroundColor');
        expect(renderer.root.findByProps({ testID: 'public-session-published-at' }).props.children)
            .toBe(new Date(snapshot.sharedAt).toLocaleString());

        act(() => renderer.unmount());
    });

    it('renders the immutable generation cover and opens its canonical snapshot attribution', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    {...defaultAppearanceProps}
                    publicId="public/id"
                    publishedAt={coveredSnapshot.sharedAt}
                    snapshot={coveredSnapshot}
                />,
            );
        });

        const cover = renderer.root.findByProps({ testID: 'public-session-cover-image' });
        expect(cover.props.source).toEqual({
            uri: 'https://47.115.228.20:8443/v1/public/session-shares/public%2Fid/attachments/51515151-5151-4515-8515-515151515151',
        });
        expect(cover.props.resizeMode).toBe('cover');
        const attribution = renderer.root.findByProps({ testID: 'public-session-cover-attribution' });
        expect(attribution.props.accessibilityRole).toBe('link');
        act(() => attribution.props.onPress());
        expect(mocks.openURL).toHaveBeenCalledWith('https://www.pexels.com/photo/731889/');

        act(() => renderer.unmount());
    });

    it('does not reserve a cover banner for a snapshot without a cover', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    {...defaultAppearanceProps}
                    publicId="public-id"
                    publishedAt={snapshot.sharedAt}
                    snapshot={snapshot}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'public-session-cover' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'public-session-cover-image' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('offers three accessible toggle buttons with pressed state and focus tooltips', () => {
        const setAppearanceMode = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    publicId="public-id"
                    publishedAt={coveredSnapshot.sharedAt}
                    snapshot={coveredSnapshot}
                    appearanceMode="system"
                    onAppearanceModeChange={setAppearanceMode}
                />,
            );
        });

        const group = renderer.root.findByProps({ testID: 'public-session-appearance-mode' });
        expect(group.props.accessibilityRole).toBeUndefined();
        expect(group.props.accessibilityLabel).toBe('sessionShare.appearance');
        const buttons = renderer.root.findAll((node: any) => node.props.accessibilityRole === 'button');
        expect(buttons.map((button: any) => button.props.accessibilityLabel)).toEqual([
            'sessionShare.appearanceLight',
            'sessionShare.appearanceDark',
            'sessionShare.appearanceSystem',
        ]);
        expect(buttons.map((button: any) => button.props['aria-pressed'])).toEqual([false, false, true]);
        expect(buttons.map((button: any) => button.props['aria-selected'])).toEqual([undefined, undefined, undefined]);
        act(() => buttons[0].props.onFocus());
        expect(renderer.root.findByProps({ testID: 'public-session-appearance-tooltip-light' }).props.visible).toBe(true);
        act(() => buttons[0].props.onBlur());
        expect(renderer.root.findByProps({ testID: 'public-session-appearance-tooltip-light' }).props.visible).toBe(false);
        act(() => buttons[1].props.onHoverIn());
        expect(renderer.root.findByProps({ testID: 'public-session-appearance-tooltip-dark' }).props.visible).toBe(true);
        act(() => buttons[1].props.onHoverOut());
        expect(renderer.root.findByProps({ testID: 'public-session-appearance-tooltip-dark' }).props.visible).toBe(false);
        act(() => buttons[1].props.onPress());
        expect(setAppearanceMode).toHaveBeenCalledWith('dark');
        expect(renderer.root.findAllByProps({ testID: 'public-session-theme-pack-picker' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('keeps the virtualized scroll owner viewport-wide while centering only list content', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionTranscript
                    {...defaultAppearanceProps}
                    publicId="public-id"
                    publishedAt={snapshot.sharedAt}
                    snapshot={snapshot}
                />,
            );
        });

        const scrollRegion = renderer.root.findByProps({ testID: 'public-session-transcript-scroll-region' });
        expect(scrollRegion.props.style).toMatchObject({ flex: 1, width: '100%' });
        expect(scrollRegion.props.style).not.toHaveProperty('maxWidth');
        expect(renderer.root.findByProps({ testID: 'conversation-transcript-list' }).props.contentContainerStyle)
            .toMatchObject({ width: '100%', maxWidth: 760, alignSelf: 'center' });

        act(() => renderer.unmount());
    });

    it('leaves the authenticated transcript content width unchanged unless a container is requested', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[]} />);
        });
        expect(renderer.root.findByProps({ testID: 'conversation-transcript-list' }).props.contentContainerStyle)
            .toBeUndefined();

        const centered = { width: '100%' as const, maxWidth: 760 };
        act(() => renderer.update(
            <ConversationTranscript metadata={null} messages={[]} contentContainerStyle={centered} />,
        ));
        expect(renderer.root.findByProps({ testID: 'conversation-transcript-list' }).props.contentContainerStyle)
            .toBe(centered);

        act(() => renderer.unmount());
    });
});
