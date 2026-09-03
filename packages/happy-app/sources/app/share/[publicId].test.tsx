import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    appearance: {
        isReady: false,
        mode: 'dark' as const,
        setMode: vi.fn(),
    },
    getSnapshot: vi.fn(),
    useAppearance: vi.fn(),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Text: 'Text',
    View: 'View',
}));
vi.mock('expo-router', () => ({
    Stack: { Screen: 'StackScreen' },
    useLocalSearchParams: () => ({ publicId: 'public-id' }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                accent: '#08f',
                groupped: { background: '#fff' },
                surfaceHigh: '#eee',
                text: '#111',
                textSecondary: '#555',
            },
        }),
    },
}));
vi.mock('@/components/PublicSessionTranscript', () => ({ PublicSessionTranscript: 'PublicSessionTranscript' }));
vi.mock('@/hooks/usePublicSessionAppearance', () => ({
    usePublicSessionAppearance: (themePack: string) => {
        mocks.useAppearance(themePack);
        return mocks.appearance;
    },
}));
vi.mock('@/sync/publicSessionShareViewer', () => ({
    getPublicSessionShareSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
}));
vi.mock('@/text/publicSessionShareText', () => ({ publicSessionShareText: (key: string) => key }));

import PublicSessionSharePage from './[publicId]';

const snapshot = {
    version: 2 as const,
    title: 'Ready share',
    sharedAt: 1_788_000_000_000,
    appearance: { themePack: 'gingham' as const },
    messages: [],
};

describe('PublicSessionSharePage appearance readiness', () => {
    let renderer: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.appearance.isReady = false;
        mocks.getSnapshot.mockResolvedValue({ snapshot, publishedAt: snapshot.sharedAt });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('keeps the ready transcript absent until the owner pack and visitor mode are applied', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<PublicSessionSharePage />);
        });
        await act(async () => {
            await vi.waitFor(() => expect(mocks.useAppearance).toHaveBeenCalledWith('gingham'));
        });

        expect(renderer.root.findAllByType('PublicSessionTranscript')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'public-session-share-appearance-loading' })).toHaveLength(1);

        mocks.appearance.isReady = true;
        act(() => renderer.update(<PublicSessionSharePage />));
        const transcript = renderer.root.findByType('PublicSessionTranscript');
        expect(transcript.props).toMatchObject({
            appearanceMode: 'dark',
            publicId: 'public-id',
            snapshot,
        });
    });
});
