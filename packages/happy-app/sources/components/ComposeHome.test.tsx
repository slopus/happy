import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeHome } from './ComposeHome';
import { useComposeDraft } from '@/sync/composeDraft';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));

const mocks = vi.hoisted(() => ({
    isDataReady: true,
    sessionRouteBecameInteractive: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    sendMessage: vi.fn(),
    navigateToSession: vi.fn(),
    dismissTo: vi.fn(),
    onDismiss: null as (() => void) | null,
    refreshSessions: vi.fn(),
    applySettings: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    updateFastMode: vi.fn(),
    selectedImages: [] as Array<{ id: string; uri: string }>,
    setSelectedImages: null as React.Dispatch<React.SetStateAction<Array<{ id: string; uri: string }>>> | null,
    clearImages: vi.fn(),
    removeImage: vi.fn(),
    setPendingReferences: vi.fn(),
    draft: {
        agentType: 'codex',
        selectedMachineId: 'machine-1',
        selectedPath: '/Users/test/project',
        worktreeKey: null,
        permissionMode: 'default',
        modelMode: 'default',
        effortLevel: null,
        setAgentType: vi.fn(),
    },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    LayoutAnimation: { configureNext: vi.fn(), Presets: { easeInEaseOut: {} } },
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    useWindowDimensions: () => ({ width: 480, height: 800 }),
}));
vi.mock('react-native-unistyles', () => {
    const colors = {
        accent: '#58a',
        divider: '#333',
        surface: '#222',
        surfacePressed: '#333',
        text: '#fff',
        textSecondary: '#aaa',
        textDestructive: '#f66',
        groupped: { background: '#111' },
        header: { tint: '#fff' },
        input: { background: '#222' },
        status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },
        button: { primary: { background: '#58a', tint: '#fff' } },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (theme: { colors: typeof colors; dark: boolean }) => object)({ colors, dark: true })
                : factory,
        },
        useUnistyles: () => ({ theme: { colors, dark: true } }),
    };
});
vi.mock('expo-router', () => ({
    useRouter: () => ({ canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn(),
        canDismiss: () => Boolean(mocks.onDismiss),
        dismissTo: (path: string) => { mocks.dismissTo(path); mocks.onDismiss?.(); },
        navigate: (path: string) => mocks.navigateToSession(path.replace('/session/', '')),
    }),
    useNavigation: () => ({ dispatch: vi.fn() }),
    useLocalSearchParams: () => ({}),
}));
vi.mock('@react-navigation/native', () => ({ DrawerActions: { openDrawer: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView' }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 44, useIsTablet: () => false }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), display: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useNewSessionDraft', () => ({
    useNewSessionDraft: Object.assign(
        (selector: (state: typeof mocks.draft) => unknown) => selector(mocks.draft),
        { getState: () => mocks.draft },
    ),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('@/hooks/useImagePicker', async () => {
    const ReactModule = await import('react');
    return {
        useImagePicker: (options: any) => {
            const [localImages, setLocalImages] = ReactModule.useState(mocks.selectedImages);
            const selectedImages = options?.selection?.images ?? localImages;
            const setSelectedImages: React.Dispatch<React.SetStateAction<Array<{ id: string; uri: string }>>> = options?.selection?.setImages ?? setLocalImages;
            mocks.setSelectedImages = setSelectedImages;
            return {
                selectedImages,
                pickImages: vi.fn(),
                pickAttachment: vi.fn(),
                removeImage: (id: string) => {
                    mocks.removeImage(id);
                    setSelectedImages((current) => current.filter((image) => image.id !== id));
                },
                clearImages: () => {
                    mocks.clearImages();
                    setSelectedImages([]);
                },
                addImages: (images: Array<{ id: string; uri: string }>) => setSelectedImages((current) => [...current, ...images]),
            };
        },
    };
});
vi.mock('@/sync/storage', () => {
    const storage = Object.assign(
        (selector: (state: unknown) => unknown) => selector({ sessions: {}, sessionMessages: {} }),
        {
            getState: () => ({
                sessions: {},
                sessionMessages: {},
                settings: { sidebarOrganization: { lists: [], tags: [], sessions: {} } },
                updateSessionPermissionMode: mocks.updatePermission,
                updateSessionModelMode: mocks.updateModel,
                updateSessionEffortLevel: mocks.updateEffort,
                updateSessionFastMode: mocks.updateFastMode,
            }),
        },
    );
    const machine = {
        id: 'machine-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { host: 'mac', homeDir: '/Users/test' }, metadataVersion: 1,
        daemonState: null, daemonStateVersion: 1,
    };
    return {
        storage,
        useIsDataReady: () => mocks.isDataReady,
        useProfile: () => ({ id: 'profile-1', firstName: 'Test' }),
        useAllMachines: () => [machine],
        useLocalSetting: (key: string) => key === 'agents' ? [] : null,
        useLocalSettingMutable: () => [false, vi.fn()],
        useSetting: () => ({}),
        useSettingMutable: (key: string) => key === 'pendingCustomImageStyleReferences'
            ? [[], mocks.setPendingReferences]
            : [[], vi.fn()],
    };
});
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({
    useDesktopWorkspaceLayout: () => ({
        leftVisible: false,
        leftWidth: 0,
        rightPanelAvailable: false,
        rightExpandedWidth: 0,
        rightWidth: 0,
    }),
}));
vi.mock('./DesktopSettingsModal', () => ({ useDesktopSettingsModal: () => ({ openSettings: vi.fn() }) }));
vi.mock('@/hooks/useGeneratedImagesPlugin', () => ({ useGeneratedImagesPlugin: () => ({ status: { installed: false } }) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: mocks.machineSpawnNewSession, sessionArchive: vi.fn() }));
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionHydrated: mocks.ensureSessionHydrated,
        refreshSessions: mocks.refreshSessions,
        sendMessage: mocks.sendMessage,
        applySettings: mocks.applySettings,
        sessionRouteBecameInteractive: mocks.sessionRouteBecameInteractive,
    },
}));
vi.mock('@/track', () => ({ trackSessionSwitched: vi.fn() }));
vi.mock('@/utils/normalizeImageForUpload', () => ({ normalizeImageForUpload: vi.fn() }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('./navigation/Header', () => ({ Header: 'Header' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 720, headerMaxWidth: 720 } }));
vi.mock('./MessageComposer', () => ({ MessageComposer: 'MessageComposer' }));
vi.mock('./SessionConfigPanel', () => ({ SessionConfigPanel: 'SessionConfigPanel' }));
vi.mock('./ComposeHomeParticles', () => ({ ComposeHomeParticles: 'ComposeHomeParticles' }));
vi.mock('./Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('./RightSwipePanelHost', () => ({ RightSwipePanelHost: 'RightSwipePanelHost', useRightSwipePanel: () => null }));
vi.mock('./rightPanel/SessionCapabilityHub', () => ({ SessionCapabilityHub: 'SessionCapabilityHub' }));
vi.mock('./DesktopRightPanel', () => ({ DesktopRightPanel: 'DesktopRightPanel', DesktopRightPanelToggleButton: 'DesktopRightPanelToggleButton' }));
vi.mock('./agents/ImageStyleGallerySheet', () => ({ ImageStyleGallerySheet: 'ImageStyleGallerySheet' }));
vi.mock('./agents/builtinAgents', () => ({ createAppBuilderAgent: () => null }));

describe('ComposeHome session hydration recovery', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isDataReady = true;
        mocks.selectedImages = [
            { id: 'image-a', uri: 'file:///a.png' },
            { id: 'image-b', uri: 'file:///b.png' },
        ];
        mocks.setSelectedImages = null;
        useComposeDraft.setState({ text: '', revision: 0, images: mocks.selectedImages as any });
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        mocks.refreshSessions.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        mocks.onDismiss = null;
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
    });

    it('defers first history load until active bootstrap is ready', async () => {
        vi.useFakeTimers();
        mocks.isDataReady = false;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mocks.sessionRouteBecameInteractive).not.toHaveBeenCalled();
        mocks.isDataReady = true;
        act(() => { renderer.update(<ComposeHome variant="home" />); });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mocks.sessionRouteBecameInteractive).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('preserves newer compose revisions through the real navigate hook dismiss, unmount, and remount', async () => {
        vi.useFakeTimers();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => { renderer.root.findByType('MessageComposer').props.onChangeText('submitted-revision'); });
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await vi.runAllTimersAsync();
        });
        act(() => {
            const composer = renderer.root.findByType('MessageComposer');
            composer.props.onChangeText('retained-revision');
            composer.props.onAddImages([{ id: 'retained-image', uri: 'synthetic-image' }]);
        });
        mocks.ensureSessionHydrated.mockResolvedValue(true);
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        mocks.onDismiss = () => renderer.unmount();
        await act(async () => {
            await renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress();
        });
        expect(mocks.dismissTo).toHaveBeenCalledWith('/');
        expect(renderer.toJSON()).toBeNull();
        mocks.onDismiss = null;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="home" />); });
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('retained-revision');
        expect(renderer.root.findByType('MessageComposer').props.selectedImages?.map((image: any) => image.id)).toEqual(['retained-image']);
        act(() => renderer.unmount());
    });

    it('queues the submitted snapshot while preserving text and attachment edits made after hydration failure', async () => {
        vi.useFakeTimers();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ComposeHome variant="screen" />);
        });

        act(() => {
            renderer.root.findByType('MessageComposer').props.onChangeText('Keep this draft');
        });
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await vi.runAllTimersAsync();
        });

        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('Keep this draft');
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.clearImages).not.toHaveBeenCalled();

        const notice = renderer.root.findByProps({ testID: 'compose-home-session-hydration-error' });
        expect(notice.findAllByType('Text')[0].props.children).toBe('newSession.sessionHydrationFailed');
        expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(4);
        expect(mocks.refreshSessions).not.toHaveBeenCalled();

        act(() => {
            const composer = renderer.root.findByType('MessageComposer');
            composer.props.onChangeText('Edited after failure');
            composer.props.onAddImages([{ id: 'image-c', uri: 'file:///c.png' }]);
            composer.props.onRemoveImage('image-b');
        });
        expect(renderer.root.findByType('MessageComposer').props.selectedImages).toEqual([
            { id: 'image-a', uri: 'file:///a.png' },
            { id: 'image-c', uri: 'file:///c.png' },
        ]);

        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await Promise.resolve();
        });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);

        mocks.ensureSessionHydrated.mockResolvedValue(true);
        await act(async () => {
            await renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress();
        });

        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', 'Keep this draft', {
            source: 'new_session',
            attachments: [
                { id: 'image-a', uri: 'file:///a.png' },
                { id: 'image-b', uri: 'file:///b.png' },
            ],
        });
        expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        expect(mocks.updatePermission).toHaveBeenCalledTimes(1);
        expect(mocks.clearImages).not.toHaveBeenCalled();
        expect.soft(renderer.root.findByType('MessageComposer').props.initialValue).toBe('Edited after failure');
        expect.soft(renderer.root.findByType('MessageComposer').props.selectedImages).toEqual([
            { id: 'image-c', uri: 'file:///c.png' },
        ]);
        act(() => renderer.unmount());
    });

    it('clears the unchanged submitted text and attachments after the local queue accepts retry', async () => {
        vi.useFakeTimers();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ComposeHome variant="screen" />);
        });

        act(() => {
            renderer.root.findByType('MessageComposer').props.onChangeText('Queued unchanged');
        });
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await vi.runAllTimersAsync();
        });

        mocks.ensureSessionHydrated.mockResolvedValue(true);
        let resolveQueue: (() => void) | undefined;
        mocks.sendMessage.mockImplementation(() => new Promise((resolve) => {
            resolveQueue = () => resolve({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        }));
        const retry = renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress;
        let retryPromise!: Promise<void>;
        await act(async () => {
            retryPromise = retry();
            await Promise.resolve();
        });

        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('Queued unchanged');
        expect(renderer.root.findByType('MessageComposer').props.selectedImages).toEqual([
            { id: 'image-a', uri: 'file:///a.png' },
            { id: 'image-b', uri: 'file:///b.png' },
        ]);

        await act(async () => {
            resolveQueue?.();
            await retryPromise;
        });

        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        expect(renderer.root.findByType('MessageComposer').props.selectedImages).toBeUndefined();
        act(() => renderer.unmount());
    });

    it('does not queue, navigate, or clear newer edits when hydration resolves after unmount', async () => {
        vi.useFakeTimers();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ComposeHome variant="screen" />);
        });

        act(() => {
            renderer.root.findByType('MessageComposer').props.onChangeText('Submitted draft');
        });
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await vi.runAllTimersAsync();
        });

        act(() => {
            const composer = renderer.root.findByType('MessageComposer');
            composer.props.onChangeText('Unsent edit after failure');
            composer.props.onAddImages([{ id: 'image-c', uri: 'file:///c.png' }]);
        });

        let resolveHydration: ((hydrated: boolean) => void) | undefined;
        mocks.ensureSessionHydrated.mockImplementation(() => new Promise<boolean>((resolve) => {
            resolveHydration = resolve;
        }));
        const retry = renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress;
        let retryPromise!: Promise<void>;
        await act(async () => {
            retryPromise = retry();
            await Promise.resolve();
        });

        expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(5);
        act(() => renderer.unmount());
        await act(async () => {
            resolveHydration?.(true);
            await retryPromise;
        });

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.updatePermission).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.clearImages).not.toHaveBeenCalled();
        expect(mocks.removeImage).not.toHaveBeenCalled();
        expect(consoleErrorSpy.mock.calls.filter((values) => (
            values[0] !== 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer'
        ))).toEqual([]);
    });
});
