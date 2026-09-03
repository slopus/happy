import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

type MediaListener = (event: { matches: boolean }) => void;

const mocks = vi.hoisted(() => ({
    getSnapshot: vi.fn(),
    rootBackground: vi.fn(),
    setTheme: vi.fn(),
    themeName: 'caramelDark',
    transcriptMounts: 0,
    transcriptSequence: 0,
    transcriptUnmounts: 0,
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
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
    UnistylesRuntime: {
        get themeName() { return mocks.themeName; },
        getTheme: () => ({ colors: { groupped: { background: '#1A1512' } } }),
        setRootViewBackgroundColor: (background: string) => mocks.rootBackground(background),
        setTheme: (themeName: string) => {
            mocks.themeName = themeName;
            mocks.setTheme(themeName);
        },
    },
}));
vi.mock('@/components/PublicSessionTranscript', async () => {
    const ReactModule = await import('react');
    return {
        PublicSessionTranscript: (props: {
            appearanceMode: 'light' | 'dark' | 'system';
            onAppearanceModeChange: (mode: 'light' | 'dark' | 'system') => void;
            snapshot: { messages: unknown[] };
        }) => {
            const instanceId = ReactModule.useRef<number | null>(null);
            if (instanceId.current === null) instanceId.current = ++mocks.transcriptSequence;
            const mountedTheme = ReactModule.useRef(mocks.themeName);
            const [scrollOffset, setScrollOffset] = ReactModule.useState(0);
            ReactModule.useEffect(() => {
                mocks.transcriptMounts += 1;
                return () => { mocks.transcriptUnmounts += 1; };
            }, []);
            return ReactModule.createElement('TranscriptListMarker', {
                appearanceMode: props.appearanceMode,
                instanceId: instanceId.current,
                messageCount: props.snapshot.messages.length,
                mountedTheme: mountedTheme.current,
                onModeChange: props.onAppearanceModeChange,
                onScroll: setScrollOffset,
                scrollOffset,
            });
        },
    };
});
vi.mock('@/sync/publicSessionShareViewer', () => ({
    getPublicSessionShareSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
}));
vi.mock('@/text/publicSessionShareText', () => ({ publicSessionShareText: (key: string) => key }));

import PublicSessionSharePage from './[publicId]';

function createMediaQuery(initialMatches: boolean) {
    const listeners = new Set<MediaListener>();
    return {
        addEventListener: vi.fn((_type: string, listener: MediaListener) => listeners.add(listener)),
        dispatch(matches: boolean) {
            this.matches = matches;
            for (const listener of listeners) listener({ matches });
        },
        listeners,
        matches: initialMatches,
        media: '(prefers-color-scheme: dark)',
        removeEventListener: vi.fn((_type: string, listener: MediaListener) => listeners.delete(listener)),
    };
}

function createLocalStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
}

const longSnapshot = {
    version: 2 as const,
    title: 'Long public session',
    sharedAt: 1_788_000_000_000,
    appearance: { themePack: 'gingham' as const },
    messages: Array.from({ length: 200 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'assistant' as const : 'user' as const,
        createdAt: 1_788_000_000_000 + index,
        blocks: [{ type: 'text' as const, markdown: `Message ${index}` }],
    })),
};

describe('PublicSessionSharePage appearance integration', () => {
    let renderer: any;
    let mediaQuery: ReturnType<typeof createMediaQuery>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.themeName = 'caramelDark';
        mocks.transcriptMounts = 0;
        mocks.transcriptSequence = 0;
        mocks.transcriptUnmounts = 0;
        mediaQuery = createMediaQuery(false);
        vi.stubGlobal('window', {
            localStorage: createLocalStorage(),
            matchMedia: vi.fn(() => mediaQuery),
        });
        mocks.getSnapshot.mockResolvedValue({ snapshot: longSnapshot, publishedAt: longSnapshot.sharedAt });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
        vi.unstubAllGlobals();
    });

    it('keeps the long transcript list and scroll state mounted across visitor and system mode changes', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<PublicSessionSharePage />);
        });
        await act(async () => {
            await vi.waitFor(() => expect(renderer.root.findAllByType('TranscriptListMarker')).toHaveLength(1));
        });

        const currentList = () => renderer.root.findByType('TranscriptListMarker');
        const initialInstanceId = currentList().props.instanceId;
        expect(currentList().props).toMatchObject({
            appearanceMode: 'system',
            messageCount: 200,
            mountedTheme: 'ginghamLight',
        });
        act(() => currentList().props.onScroll(640));

        act(() => currentList().props.onModeChange('dark'));
        expect(currentList().props).toMatchObject({
            appearanceMode: 'dark',
            instanceId: initialInstanceId,
            scrollOffset: 640,
        });
        expect(mocks.themeName).toBe('ginghamDark');

        act(() => currentList().props.onModeChange('light'));
        mediaQuery.dispatch(true);
        act(() => currentList().props.onModeChange('system'));
        expect(currentList().props).toMatchObject({
            appearanceMode: 'system',
            instanceId: initialInstanceId,
            scrollOffset: 640,
        });
        expect(mocks.themeName).toBe('ginghamDark');

        act(() => mediaQuery.dispatch(false));
        expect(currentList().props).toMatchObject({
            instanceId: initialInstanceId,
            scrollOffset: 640,
        });
        expect(mocks.themeName).toBe('ginghamLight');
        expect(mocks.transcriptMounts).toBe(1);
        expect(mocks.transcriptUnmounts).toBe(0);
    });
});
