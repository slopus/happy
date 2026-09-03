import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

import RelationshipAdvisorScreen from './relationship-advisor';

const mocks = vi.hoisted(() => ({
    router: { setParams: vi.fn(), replace: vi.fn() },
    pluginStatus: { installed: true } as { installed: boolean } | null,
    conversations: [{
        id: 'conversation-1',
        title: 'Conversation',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
    }],
    updateConversations: vi.fn(),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: 'KeyboardControllerAvoidingView',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-conversation-id' }));
vi.mock('expo-router', () => ({
    Stack: { Screen: 'StackScreen' },
    useLocalSearchParams: () => ({ conversationId: 'conversation-1' }),
    useRouter: () => mocks.router,
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                accent: '#00f',
                divider: '#ddd',
                header: { tint: '#111' },
                surface: '#fff',
                surfacePressed: '#eee',
                surfaceSelected: '#ddd',
                text: '#111',
                textSecondary: '#666',
            },
        }),
        hairlineWidth: 1,
    },
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#111' }, textSecondary: '#666' } } }),
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 960 } }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/MessageComposer', () => ({ MessageComposer: 'MessageComposer' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useImagePicker', () => ({
    useImagePicker: () => ({
        selectedImages: [],
        pickImages: vi.fn(),
        removeImage: vi.fn(),
        clearImages: vi.fn(),
        addImages: vi.fn(),
    }),
}));
vi.mock('@/hooks/useRelationshipAdvisorChat', () => ({
    useRelationshipAdvisorChat: () => ({
        messages: [],
        activeRequestId: null,
        streamingText: '',
        error: null,
        send: vi.fn(),
        cancel: vi.fn(),
        clear: vi.fn(),
        canRetry: false,
        retry: vi.fn(),
    }),
}));
vi.mock('@/hooks/useRelationshipAdvisorPlugin', () => ({
    useRelationshipAdvisorPlugin: () => ({
        loading: false,
        status: mocks.pluginStatus,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/components/relationship-advisor/relationshipAdvisorChatModel', () => ({
    shouldShowRelationshipAdvisorEmptyState: () => true,
}));
vi.mock('@/components/relationship-advisor/StreamingMarkdownView', () => ({
    StreamingMarkdownView: 'StreamingMarkdownView',
}));
vi.mock('@/sync/relationshipAdvisorImages', () => ({ MAX_RELATIONSHIP_ADVISOR_IMAGE_SIZE: 1 }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => mocks.conversations,
    useLocalSettingUpdater: () => mocks.updateConversations,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('RelationshipAdvisorScreen', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pluginStatus = { installed: true };
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    it('moves the Android composer above the keyboard', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorScreen />);
        });

        const avoidingView = renderer.root.findByType('KeyboardControllerAvoidingView');
        expect(avoidingView.props.behavior).toBe('padding');
        expect(avoidingView.props.keyboardVerticalOffset).toBe(0);

        act(() => renderer.unmount());
    });

    it('redirects direct access to plugin installation when the advisor is not installed', () => {
        mocks.pluginStatus = { installed: false };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorScreen />);
        });

        expect(mocks.router.replace).toHaveBeenCalledWith('/settings/relationship-advisor');
        expect(renderer.root.findAllByProps({ testID: 'relationship-advisor-screen' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
