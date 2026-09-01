import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    platformOS: 'web',
    windowWidth: 1440,
    copy: vi.fn(),
    openUrl: vi.fn(),
    publish: vi.fn(),
    revoke: vi.fn(),
    share: {
        checking: false,
        progress: { completed: 0, total: 0 },
        publishing: false,
        revoking: false,
        shareState: { active: false, publicId: null, publishedAt: null } as {
            active: boolean;
            publicId: string | null;
            publishedAt: number | null;
        },
        shareUrl: null as string | null,
    },
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Linking: { openURL: mocks.openUrl },
    Platform: {
        get OS() { return mocks.platformOS; },
        select: (options: Record<string, unknown>) => options[mocks.platformOS] ?? options.default,
    },
    Pressable: 'Pressable',
    Text: 'Text',
    useWindowDimensions: () => ({ width: mocks.windowWidth, height: 844, scale: 1, fontScale: 1 }),
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('@/hooks/usePublicSessionShare', () => ({
    usePublicSessionShare: () => ({
        ...mocks.share,
        publish: mocks.publish,
        revoke: mocks.revoke,
    }),
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'sessionShare.uploading') return `Uploading ${params?.completed}/${params?.total}`;
        if (key === 'sessionShare.sharedOn') return `Shared ${params?.date}`;
        return key;
    },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                accent: '#08f',
                divider: '#444',
                surface: '#181818',
                surfaceHigh: '#222',
                text: '#fff',
                textSecondary: '#aaa',
                warning: '#f90',
                button: {
                    primary: { background: '#08f', tint: '#fff' },
                    destructive: { background: '#b42318', backgroundPressed: '#8f1d14', tint: '#fff' },
                },
                status: { connected: '#0f0' },
            },
        }),
    },
}));

import { PublicSessionShareDialog } from './PublicSessionShareDialog';

function renderDialog() {
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(
            <PublicSessionShareDialog sessionId="session-1" title="Release notes" onClose={vi.fn()} />,
        );
    });
    return renderer;
}

function flattenStyle(style: unknown) {
    const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
    return Object.assign({}, ...(Array.isArray(resolved) ? resolved : [resolved]));
}

describe('PublicSessionShareDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.share.progress = { completed: 0, total: 0 };
        mocks.share.checking = false;
        mocks.share.publishing = false;
        mocks.share.revoking = false;
        mocks.share.shareState = { active: false, publicId: null, publishedAt: null };
        mocks.share.shareUrl = null;
        mocks.platformOS = 'web';
        mocks.windowWidth = 1440;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('explains the public immutable snapshot before the first share', () => {
        const renderer = renderDialog();

        expect(renderer.root.findAllByProps({ testID: 'public-session-share-privacy-message' })).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-create' }).props.onPress());
        expect(mocks.publish).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });

    it('manages an active link with copy, open, update, and revoke actions', async () => {
        mocks.share.shareState = { active: true, publicId: 'public-id', publishedAt: 1_788_000_000_000 };
        mocks.share.shareUrl = 'https://paws.example/share/public-id';
        const renderer = renderDialog();

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-session-share-copy' }).props.onPress();
        });
        await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('https://paws.example/share/public-id'));
        act(() => renderer.root.findByProps({ testID: 'public-session-share-open' }).props.onPress());
        expect(mocks.openUrl).toHaveBeenCalledWith('https://paws.example/share/public-id');
        act(() => renderer.root.findByProps({ testID: 'public-session-share-update' }).props.onPress());
        expect(mocks.publish).toHaveBeenCalledTimes(1);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-revoke' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'public-session-share-revoke-confirmation' })).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-revoke-confirm' }).props.onPress());
        expect(mocks.revoke).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });

    it('keeps the Android checking state full-width and explains the wait', () => {
        mocks.platformOS = 'android';
        mocks.windowWidth = 360;
        mocks.share.checking = true;
        const renderer = renderDialog();

        const dialog = renderer.root.findByProps({ testID: 'public-session-share-dialog' });
        const dialogStyle = flattenStyle(dialog.props.style);
        expect(dialogStyle.width).toBe(328);
        const checking = renderer.root.findByProps({ testID: 'public-session-share-checking' });
        expect(checking.findAllByType('Text').map((node: any) => node.props.children)).toContain('sessionShare.preparing');

        act(() => renderer.unmount());
    });

    it('keeps header controls and footer actions from overlapping on narrow Android screens', () => {
        mocks.platformOS = 'android';
        mocks.windowWidth = 320;
        const renderer = renderDialog();

        const close = renderer.root.findByProps({ testID: 'public-session-share-close' });
        expect(flattenStyle(close.props.style)).toMatchObject({ flexShrink: 0 });
        const header = close.parent;
        expect(flattenStyle(header.children[0].props.style)).toMatchObject({ minWidth: 0 });
        expect(flattenStyle(header.children[0].children[1].props.style)).toMatchObject({ minWidth: 0 });

        const create = renderer.root.findByProps({ testID: 'public-session-share-create' });
        expect(flattenStyle(create.props.style)).toMatchObject({ flex: 1.6, minWidth: 0 });
        const cancel = renderer.root.findAllByProps({ accessibilityLabel: 'common.cancel' })
            .find((node: any) => node !== close && node.type === 'Pressable');
        expect(flattenStyle(cancel?.props.style)).toMatchObject({ flex: 1, minWidth: 0 });

        act(() => renderer.unmount());
    });

    it('queues a mobile share and closes the dialog without waiting for completion', () => {
        mocks.platformOS = 'android';
        mocks.publish.mockReturnValue(true);
        const onClose = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PublicSessionShareDialog sessionId="session-1" title="Release notes" onClose={onClose} />,
            );
        });

        act(() => renderer.root.findByProps({ testID: 'public-session-share-create' }).props.onPress());

        expect(mocks.publish).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });
});
