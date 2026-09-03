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
    lastPublicShareThemePack: 'grape',
    share: {
        checking: false,
        progress: { completed: 0, total: 0 },
        publishing: false,
        revoking: false,
        shareState: { active: false, publicId: null, publishedAt: null } as {
            active: boolean;
            publicId: string | null;
            publishedAt: number | null;
            appearance?: {
                themePack: 'caramel' | 'gingham' | 'terminal' | 'acorn' | 'sage' | 'sakura' | 'grape';
                cover?: {
                    assetId: string;
                    mimeType: string;
                    size: number;
                    width: number;
                    height: number;
                    attribution?: {
                        photoId: number;
                        photographer: string;
                        photographerUrl: string;
                        photoUrl: string;
                    };
                };
            };
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
    ScrollView: 'ScrollView',
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
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => mocks.lastPublicShareThemePack,
}));
vi.mock('@/sync/publicSessionShareViewer', () => ({
    getPublicSessionAttachmentUrl: (publicId: string, assetId: string) => `https://paws.example/share/${publicId}/${assetId}`,
}));
vi.mock('./PublicSessionShareAppearanceControls', () => ({
    PublicSessionShareAppearanceControls: 'PublicSessionShareAppearanceControls',
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
        mocks.lastPublicShareThemePack = 'grape';
        mocks.platformOS = 'web';
        mocks.windowWidth = 1440;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
        vi.unstubAllGlobals();
    });

    it('explains the public immutable snapshot before the first share', () => {
        const renderer = renderDialog();

        expect(renderer.root.findAllByProps({ testID: 'public-session-share-privacy-message' })).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-create' }).props.onPress());
        expect(mocks.publish).toHaveBeenCalledWith({ themePack: 'grape', coverSelection: undefined });

        act(() => renderer.unmount());
    });

    it('disables create and refuses publication while a random replacement is unresolved', () => {
        const renderer = renderDialog();
        const controls = renderer.root.findByType('PublicSessionShareAppearanceControls');

        act(() => controls.props.onReplacementBusyChange(true));

        const create = renderer.root.findByProps({ testID: 'public-session-share-create' });
        expect(create.props.disabled).toBe(true);
        act(() => create.props.onPress());
        expect(mocks.publish).not.toHaveBeenCalled();

        act(() => controls.props.onReplacementBusyChange(false));
        expect(renderer.root.findByProps({ testID: 'public-session-share-create' }).props.disabled).toBe(false);
        act(() => renderer.unmount());
    });

    it('disables update and refuses publication while upload normalization is unresolved', () => {
        mocks.share.shareState = { active: true, publicId: 'public-id', publishedAt: 1_788_000_000_000 };
        mocks.share.shareUrl = 'https://paws.example/share/public-id';
        const renderer = renderDialog();
        const controls = renderer.root.findByType('PublicSessionShareAppearanceControls');

        act(() => controls.props.onReplacementBusyChange(true));

        const update = renderer.root.findByProps({ testID: 'public-session-share-update' });
        expect(update.props.disabled).toBe(true);
        act(() => update.props.onPress());
        expect(mocks.publish).not.toHaveBeenCalled();

        act(() => controls.props.onReplacementBusyChange(false));
        expect(renderer.root.findByProps({ testID: 'public-session-share-update' }).props.disabled).toBe(false);
        act(() => renderer.unmount());
    });

    it('blocks revoke entry during replacement and restores update after the replacement settles', () => {
        mocks.share.shareState = { active: true, publicId: 'public-id', publishedAt: 1_788_000_000_000 };
        mocks.share.shareUrl = 'https://paws.example/share/public-id';
        const renderer = renderDialog();
        const controls = renderer.root.findByType('PublicSessionShareAppearanceControls');

        act(() => controls.props.onReplacementBusyChange(true));
        const revoke = renderer.root.findByProps({ testID: 'public-session-share-revoke' });
        expect(revoke.props.disabled).toBe(true);
        act(() => revoke.props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'public-session-share-revoke-confirmation' })).toHaveLength(0);

        act(() => controls.props.onReplacementBusyChange(false));
        expect(renderer.root.findByProps({ testID: 'public-session-share-update' }).props.disabled).toBe(false);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-revoke' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'public-session-share-revoke-confirmation' })).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-revoke-cancel' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'public-session-share-update' }).props.disabled).toBe(false);
        act(() => renderer.root.findByProps({ testID: 'public-session-share-update' }).props.onPress());
        expect(mocks.publish).toHaveBeenCalledOnce();

        act(() => renderer.unmount());
    });

    it('initializes an active update from its immutable snapshot instead of the last-used default', () => {
        mocks.share.shareState = {
            active: true,
            publicId: 'public-id',
            publishedAt: 1_788_000_000_000,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '11111111-1111-4111-8111-111111111111',
                    mimeType: 'image/webp',
                    size: 2048,
                    width: 1600,
                    height: 900,
                    attribution: {
                        photoId: 731889,
                        photographer: 'Ada Stone',
                        photographerUrl: 'https://www.pexels.com/@ada-stone',
                        photoUrl: 'https://www.pexels.com/photo/731889',
                    },
                },
            },
        };
        mocks.share.shareUrl = 'https://paws.example/share/public-id';
        const renderer = renderDialog();

        const controls = renderer.root.findByType('PublicSessionShareAppearanceControls');
        expect(controls.props).toMatchObject({
            sessionId: 'session-1',
            themePack: 'sage',
            coverSelection: { kind: 'existing', assetId: '11111111-1111-4111-8111-111111111111' },
            existingCover: {
                uri: 'https://paws.example/share/public-id/11111111-1111-4111-8111-111111111111',
            },
        });
        act(() => renderer.root.findByProps({ testID: 'public-session-share-update' }).props.onPress());
        expect(mocks.publish).toHaveBeenCalledWith({
            themePack: 'sage',
            coverSelection: { kind: 'existing', assetId: '11111111-1111-4111-8111-111111111111' },
        });

        act(() => renderer.unmount());
    });

    it('resets a revoked share to the remembered theme and a coverless new-share state', () => {
        mocks.share.shareState = {
            active: true,
            publicId: 'public-id',
            publishedAt: 1_788_000_000_000,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '11111111-1111-4111-8111-111111111111',
                    mimeType: 'image/webp',
                    size: 2048,
                    width: 1600,
                    height: 900,
                },
            },
        };
        mocks.share.shareUrl = 'https://paws.example/share/public-id';
        const renderer = renderDialog();

        mocks.share.shareState = { active: false, publicId: null, publishedAt: null };
        mocks.share.shareUrl = null;
        mocks.lastPublicShareThemePack = 'grape';
        act(() => renderer.update(
            <PublicSessionShareDialog sessionId="session-1" title="Release notes" onClose={vi.fn()} />,
        ));

        const controls = renderer.root.findByType('PublicSessionShareAppearanceControls');
        expect(controls.props).toMatchObject({ themePack: 'grape', coverSelection: undefined });
        act(() => renderer.root.findByProps({ testID: 'public-session-share-create' }).props.onPress());
        expect(mocks.publish).toHaveBeenLastCalledWith({ themePack: 'grape', coverSelection: undefined });
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
        expect(renderer.root.findByProps({ testID: 'public-session-share-copy-feedback' }).props)
            .toMatchObject({ accessibilityLiveRegion: 'polite', children: 'sessionShare.linkCopied' });
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
        expect(dialogStyle.maxHeight).toBe(812);
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

    it('returns Web focus to the persistent session details trigger when it unmounts', () => {
        const focus = vi.fn();
        const querySelector = vi.fn(() => ({ focus }));
        vi.stubGlobal('document', { querySelector });
        const renderer = renderDialog();

        act(() => renderer.unmount());

        expect(querySelector).toHaveBeenCalledWith('[data-testid="session-header-more-button"]:not([aria-hidden="true"])');
        expect(focus).toHaveBeenCalledOnce();
    });
});
