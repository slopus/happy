import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesSidebar, type SidebarMode } from './FilesSidebar';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (choices: Record<string, unknown>) => choices.web ?? choices.default,
    },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Easing: { cubic: 'cubic', out: (value: unknown) => value },
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
}));
vi.mock('@expo/vector-icons', () => ({ Octicons: 'Octicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/DesktopPresenceTransition', async () => {
    const ReactModule = await import('react');
    return {
        DesktopPresenceTransition: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
            ReactModule.createElement('DesktopPresenceTransition', props, children)
        ),
    };
});
vi.mock('@/components/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            applyGitStatusFiles: vi.fn(),
            applyProjectFiles: vi.fn(),
            getSessionPathKey: () => null,
            pathProjectFiles: {},
        }),
    },
    useSessionGitStatus: () => undefined,
    useSessionGitStatusFiles: () => ({ stagedFiles: [], unstagedFiles: [] }),
    useSessionProjectFiles: () => ({ files: [] }),
}));
vi.mock('@/sync/gitStatusFiles', () => ({ getGitStatusFiles: vi.fn() }));
vi.mock('@/sync/projectFiles', () => ({ getProjectFiles: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#444444',
            gitAddedText: '#00ff00',
            gitRemovedText: '#ff0000',
            groupped: { background: '#111111' },
            input: { placeholder: '#777777' },
            surface: '#171717',
            surfacePressed: '#333333',
            text: '#ffffff',
            textSecondary: '#aaaaaa',
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

function FilesSidebarHarness() {
    const [mode, setMode] = React.useState<SidebarMode>('changes');
    return (
        <FilesSidebar
            mode={mode}
            onAllFilesFilePress={vi.fn()}
            onFilePress={vi.fn()}
            onModeChange={setMode}
            sessionId="session-1"
        />
    );
}

describe('FilesSidebar desktop tabs', () => {
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

    it('moves forward and back while keeping exactly one selected tab', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<FilesSidebarHarness />);
        });

        expect(renderer.root.findByType('DesktopPresenceTransition').props).toMatchObject({
            direction: 'back',
            testID: 'session-files-mode-transition',
            transitionKey: 'changes',
        });
        expect(renderer.root.findByProps({ testID: 'session-files-changes-tab' }).props).toMatchObject({
            accessibilityRole: 'tab',
            accessibilityState: { selected: true },
            dataSet: { happyMotion: 'desktop-tab', happyMotionState: 'selected' },
        });
        expect(renderer.root.findByProps({ testID: 'session-files-all-tab' }).props).toMatchObject({
            accessibilityRole: 'tab',
            accessibilityState: { selected: false },
            dataSet: { happyMotion: 'desktop-tab', happyMotionState: 'idle' },
        });

        act(() => renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.onPress());

        expect(renderer.root.findByType('DesktopPresenceTransition').props).toMatchObject({
            direction: 'forward',
            transitionKey: 'allFiles',
        });
        expect(renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.accessibilityState).toEqual({ selected: true });
        expect(renderer.root.findByProps({ testID: 'session-files-changes-tab' }).props.dataSet.happyMotionState).toBe('idle');
        expect(renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.dataSet.happyMotionState).toBe('selected');
        expect(renderer.root.findAll((node: any) => (
            node.props.accessibilityRole === 'tab'
            && node.props.accessibilityState?.selected === true
        ))).toHaveLength(1);

        act(() => renderer.root.findByProps({ testID: 'session-files-changes-tab' }).props.onPress());

        expect(renderer.root.findByType('DesktopPresenceTransition').props).toMatchObject({
            direction: 'back',
            transitionKey: 'changes',
        });
        expect(renderer.root.findByProps({ testID: 'session-files-changes-tab' }).props.dataSet).toEqual({
            happyMotion: 'desktop-tab',
            happyMotionState: 'selected',
        });
        expect(renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.dataSet).toEqual({
            happyMotion: 'desktop-tab',
            happyMotionState: 'idle',
        });
        expect(renderer.root.findAll((node: any) => (
            node.props.accessibilityRole === 'tab'
            && node.props.accessibilityState?.selected === true
        ))).toHaveLength(1);

        act(() => renderer.unmount());
    });
});
