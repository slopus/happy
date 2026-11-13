import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the create/unmount surface below.
import TestRenderer from 'react-test-renderer';

import { InboxView } from './InboxView';

const mocks = vi.hoisted(() => ({
    feedItems: [] as import("@/sync/feedTypes").FeedItem[],

}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            button: { primary: { background: '#444', tint: '#fff' } },
            divider: '#333',
            groupped: { background: '#111' },
            input: { placeholder: '#777' },
            status: { error: '#f00' },
            surface: '#222',
            surfaceHigh: '#292929',
            text: '#fff',
            textSecondary: '#aaa',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@/components/ItemGroup', async () => {
    const ReactModule = await import('react');
    return {
        ItemGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
            ReactModule.createElement('ItemGroup', props, children)
        ),
    };
});
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: 'UpdateBanner' }));
vi.mock('@/components/VoiceAssistantStatusBar', () => ({ VoiceAssistantStatusBar: 'VoiceAssistantStatusBar' }));
vi.mock('@/components/navigation/Header', () => ({ Header: 'Header' }));
vi.mock('@/components/FeedItemCard', () => ({ FeedItemCard: 'FeedItemCard' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 1240 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/storage', () => ({
    useFeedItems: () => mocks.feedItems,
    useFeedLoaded: () => true,
    useRealtimeStatus: () => 'disconnected',
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));

describe('InboxView updates', () => {
    let restoreAssetResolution: (() => void) | undefined;
    beforeAll(async () => {
        const nodeModule = (await import('node:module')).default as unknown as {
            _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
        };
        const original = nodeModule._resolveFilename;
        const assetMock = fileURLToPath(new URL('../../package.json', import.meta.url));
        nodeModule._resolveFilename = (request, parent, isMain, options) => request === '@/assets/images/brutalist/Brutalism-10.png'
            ? assetMock : original(request, parent, isMain, options);
        restoreAssetResolution = () => { nodeModule._resolveFilename = original; };
    });
    afterAll(() => restoreAssetResolution?.());
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.feedItems = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('keeps cached friend activity out of the empty state and removes friend actions', () => {
        mocks.feedItems = [
            { id: 'request', body: { kind: 'friend_request', uid: 'old-user' }, cursor: 'c-1', counter: 1, repeatKey: null, createdAt: 1 },
            { id: 'accepted', body: { kind: 'friend_accepted', uid: 'old-user' }, cursor: 'c-2', counter: 2, repeatKey: null, createdAt: 2 },
        ];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<InboxView />); });
        expect(JSON.stringify(renderer.toJSON())).toContain('inbox.emptyTitle');
        expect(renderer.root.findAllByType('FeedItemCard')).toHaveLength(0);
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('continues to display ordinary updates', () => {
        const update = { id: 'update', body: { kind: 'text' as const, text: 'App update' }, cursor: 'c-3', counter: 3, repeatKey: null, createdAt: 3 };
        mocks.feedItems = [update];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<InboxView />); });
        expect(renderer.root.findAllByType('FeedItemCard').map((node: any) => node.props.item)).toEqual([update]);
        act(() => renderer.unmount());
    });

});
