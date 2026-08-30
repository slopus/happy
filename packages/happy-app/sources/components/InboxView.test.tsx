import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the create/unmount surface below.
import TestRenderer from 'react-test-renderer';

import { InboxView } from './InboxView';

const mocks = vi.hoisted(() => ({
    candidates: [
        {
            threadId: 'alpha',
            title: 'Alpha browser investigation',
            directory: '/Users/test/browser',
            createdAt: 1,
            updatedAt: 3,
            machineId: 'machine-1',
            machineName: 'Mac mini',
        },
        {
            threadId: 'beta',
            title: 'Beta release preparation',
            directory: '/Users/test/release',
            createdAt: 1,
            updatedAt: 2,
            machineId: 'machine-2',
            machineName: 'MacBook Air',
        },
    ],
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
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
vi.mock('@/components/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 1240 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useCodexAttachCandidateInbox', () => ({
    useCodexAttachCandidateInbox: () => ({
        candidates: mocks.candidates,
        loading: false,
        error: null,
        busyThreadId: null,
        attach: vi.fn(),
        dismiss: vi.fn(),
    }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/storage', () => ({
    useAcceptedFriends: () => [],
    useFeedItems: () => [],
    useFeedLoaded: () => true,
    useFriendRequests: () => [],
    useFriendsLoaded: () => true,
    useRealtimeStatus: () => 'disconnected',
    useRequestedFriends: () => [],
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/track', () => ({ trackFriendsProfileView: vi.fn(), trackFriendsSearch: vi.fn() }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/utils/sessionUtils', () => ({ formatLastSeen: () => 'recently' }));

describe('InboxView Codex candidate search', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('shows a search input and hides non-matching candidate cards', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<InboxView />);
        });

        const searchInputs = renderer.root.findAllByType('TextInput');
        expect(searchInputs).toHaveLength(1);

        act(() => searchInputs[0].props.onChangeText('MACBOOK'));

        const visibleText = renderer.root.findAllByType('Text')
            .flatMap((node: any) => node.props.children)
            .filter((value: unknown): value is string => typeof value === 'string');
        expect(visibleText).toContain('Beta release preparation');
        expect(visibleText).not.toContain('Alpha browser investigation');

        act(() => searchInputs[0].props.onChangeText('no such session'));
        const emptySearchText = renderer.root.findAllByType('Text')
            .flatMap((node: any) => node.props.children)
            .filter((value: unknown): value is string => typeof value === 'string');
        expect(emptySearchText).toContain('inbox.noCodexCandidatesFound');

        act(() => renderer.unmount());
    });
});
