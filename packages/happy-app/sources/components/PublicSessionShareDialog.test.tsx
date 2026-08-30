import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
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
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable',
    Text: 'Text',
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
});
