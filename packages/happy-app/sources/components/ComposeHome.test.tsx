import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeHome } from './ComposeHome';
import { clearComposeDraft, useComposeDraft } from '@/sync/composeDraft';
import { setFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://test' }));
import type { LocalMessageQueueReceipt } from '@/sync/sync';
import { Modal } from '@/modal';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
vi.mock('@/sync/sessionStartupTrace', () => ({ traceStartup: vi.fn() }));
vi.mock('@/sync/sessionStartupTraceRuntime', () => ({ sessionStartupTraceRuntime: { begin: vi.fn(), bindSession: vi.fn() } }));

const mocks = vi.hoisted(() => ({
    platformOS: 'web',
    isDataReady: true,
    sessionRouteBecameInteractive: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    sendMessage: vi.fn(),
    awaitLocalMessageProjection: vi.fn<(sessionId: string, localIds: readonly string[], receipt: LocalMessageQueueReceipt) => Promise<boolean>>(),
    navigateToSession: vi.fn(),
    dismissTo: vi.fn(),
    onDismiss: null as (() => void) | null,
    refreshSessions: vi.fn(),
    applySettings: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    updateFastMode: vi.fn(),
    routeParams: {} as { agentId?: string },
    agents: [] as any[],
    selectedImages: [] as Array<{ id: string; uri: string }>,
    setSelectedImages: null as React.Dispatch<React.SetStateAction<Array<{ id: string; uri: string }>>> | null,
    imagePickerGeneration: null as null | { currentDraftEpoch(): number; invalidate(): void },
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
    Platform: {
        get OS() { return mocks.platformOS; },
        select: (values: Record<string, unknown>) => values[mocks.platformOS] ?? values.default,
    },
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
    useLocalSearchParams: () => mocks.routeParams,
}));
vi.mock('@react-navigation/native', () => ({ DrawerActions: { openDrawer: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView' }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 44, useIsTablet: () => false }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), display: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({
    t: (key: string, values?: { name?: string }) => key === 'composeHome.greetingAgent'
        ? `${key}:${values?.name ?? ''}`
        : key,
}));
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
            mocks.imagePickerGeneration = options?.selection?.generation ?? null;
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
        useLocalSetting: (key: string) => key === 'agents' ? mocks.agents : null,
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
        awaitLocalMessageProjection: mocks.awaitLocalMessageProjection,
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

describe('ComposeHome session hydration recovery', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
        vi.clearAllMocks();
        setFirstSubmissionScope(`test-${Math.random()}`, 'http://test');
        mocks.platformOS = 'web';
        mocks.isDataReady = true;
        mocks.routeParams = {};
        mocks.agents = [];
        mocks.selectedImages = [
            { id: 'image-a', uri: 'file:///a.png' },
            { id: 'image-b', uri: 'file:///b.png' },
        ];
        mocks.setSelectedImages = null;
        mocks.imagePickerGeneration = null;
        useComposeDraft.setState({ text: '', revision: 0, images: mocks.selectedImages as any });
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        mocks.awaitLocalMessageProjection.mockReset().mockResolvedValue(true);
        mocks.refreshSessions.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    it('keeps an existing Agent deep link readable without restoring a discovery entry point', () => {
        mocks.routeParams = { agentId: 'legacy-agent' };
        mocks.agents = [{
            id: 'legacy-agent',
            name: 'Legacy Helper',
            machineId: 'machine-1',
            path: '/Users/test/project',
            kind: 'standard',
            presets: [{ label: 'Continue plan', prompt: 'Continue the saved plan' }],
            imageStyleIds: [],
            imageVariantsPerStyle: 1,
        }];
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<ComposeHome />);
        });

        expect(renderer.root.findByProps({ testID: 'compose-home-greeting' }).props.children)
            .toBe('composeHome.greetingAgent:Legacy Helper');
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Continue plan')).toBe(true);

        act(() => renderer.unmount());
    });

    afterEach(() => {
        mocks.onDismiss = null;
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
    });

    it.each(['web', 'android'])('sends the current %s input directly after a paused launch without restoring', async platform => {
        mocks.platformOS = platform;
        mocks.machineSpawnNewSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'launch failed' });
        mocks.ensureSessionHydrated.mockResolvedValue(true);
        let renderer: any;
        act(() => { useComposeDraft.getState().setImages([]); renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('old request'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); });
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('old request');
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('new request'));
        expect(renderer.root.findByType('MessageComposer').props.isSendDisabled).toBe(false);
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            renderer.root.findByType('MessageComposer').props.onSend();
        });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(2);
        expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith('session-1', 'new request', expect.anything());
        expect(mocks.navigateToSession).toHaveBeenCalledExactlyOnceWith('session-1');
        act(() => renderer.unmount());
    });

    it('clears a paused card durably while keeping current editor text and attachments', async () => {
        mocks.machineSpawnNewSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'launch failed' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('old request'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('keep this edit'));
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-dismiss-submission' }).props.onPress(); });
        expect(renderer.root.findAllByProps({ testID: 'compose-home-starting' })).toHaveLength(0);
        expect(useComposeDraft.getState().text).toBe('keep this edit');
        expect(useComposeDraft.getState().images.map(image => image.id)).toEqual(['image-a', 'image-b']);
        const scope = getFirstSubmissionScope()!;
        expect(JSON.parse(globalThis.localStorage.getItem(`first-submission-v1:${scope.key}`)!)).toBeNull();
        act(() => { renderer.unmount(); setFirstSubmissionScope(scope.key, scope.serverUrl); });
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        expect(renderer.root.findAllByProps({ testID: 'compose-home-starting' })).toHaveLength(0);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps the card and reports failure when clearing durable storage fails', async () => {
        mocks.machineSpawnNewSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'launch failed' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('recoverable text'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); });
        const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('blocked'); });
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-dismiss-submission' }).props.onPress(); });
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('recoverable text');
        expect(Modal.alert).toHaveBeenLastCalledWith('common.error', 'newSession.submissionDismissFailed');
        setItem.mockRestore();
        act(() => renderer.unmount());
    });

    it('ignores a late check-session result after its recovery card is cleared', async () => {
        vi.useFakeTimers();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('old request'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); await vi.runAllTimersAsync(); });
        let resolveHydration!: (result: boolean) => void;
        mocks.ensureSessionHydrated.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveHydration = resolve; }));
        let checking!: Promise<void>;
        act(() => { checking = renderer.root.findByProps({ testID: 'compose-home-check-session' }).props.onPress(); });
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-dismiss-submission' }).props.onPress(); });
        await act(async () => { resolveHydration(true); await checking; });
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('preserves the uncertain-start warning when saving a new request fails', async () => {
        const scope = getFirstSubmissionScope()!;
        globalThis.localStorage.setItem(`first-submission-v1:${scope.key}`, JSON.stringify({
            version: 1, scope: scope.key, phase: 'spawning', text: 'interrupted request', prompt: 'interrupted request',
            agent: 'codex', machineId: 'machine-1', path: '/work', worktreeKey: null, attachments: [],
        }));
        setFirstSubmissionScope(scope.key, scope.serverUrl);
        let renderer: any;
        act(() => { useComposeDraft.getState().setImages([]); renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('new request'));
        const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); });
        setItem.mockRestore();
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('interrupted request');
        expect(useComposeDraft.getState().text).toBe('new request');
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'newSession.submissionSaveFailed');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-submission' }).props.onPress(); });
        expect(Modal.confirm).toHaveBeenCalledWith('newSession.submissionInterrupted', 'newSession.submissionRestoreWarning');
        expect(useComposeDraft.getState().text).toBe('new request');
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
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

    it('wires attachment invalidation to draft replacement without coupling it to text edits', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        const generation = mocks.imagePickerGeneration;
        expect(generation).not.toBeNull();
        if (!generation) return;
        const initialEpoch = generation.currentDraftEpoch();

        act(() => {
            renderer.root.findByType('MessageComposer').props.onChangeText('text-only edit');
        });
        expect(generation.currentDraftEpoch()).toBe(initialEpoch);

        act(() => { clearComposeDraft(); });
        expect(generation.currentDraftEpoch()).toBeGreaterThan(initialEpoch);
        act(() => renderer.unmount());
    });

    it.each(['web', 'android'])('preserves newer compose revisions through real %s navigation, unmount, and remount', async (platform) => {
        vi.useFakeTimers();
        mocks.platformOS = platform;
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
        // Web navigates atomically; native dismisses the compose screen first.
        if (platform === 'web') {
            mocks.navigateToSession.mockImplementationOnce(() => renderer.unmount());
        }
        await act(async () => {
            await renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress();
        });
        if (platform === 'web') {
            expect(mocks.dismissTo).not.toHaveBeenCalled();
        } else {
            expect(mocks.dismissTo).toHaveBeenCalledWith('/');
        }
        expect(mocks.navigateToSession).toHaveBeenCalledExactlyOnceWith('session-1');
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
        const attachmentEpochBeforeSubmit = mocks.imagePickerGeneration?.currentDraftEpoch();
        await act(async () => {
            renderer.root.findByType('MessageComposer').props.onSend();
            await vi.runAllTimersAsync();
        });

        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        expect(renderer.root.findByType('MessageComposer').props.isSending).toBe(false);
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('Keep this draft');
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

        // New input may be submitted independently; retry still belongs to the
        // saved original when the user chooses the recovery action instead.
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);

        mocks.ensureSessionHydrated.mockResolvedValue(true);
        await act(async () => {
            await renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress();
        });

        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', 'Keep this draft', {
            isCurrent: expect.any(Function),
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
        expect(mocks.imagePickerGeneration?.currentDraftEpoch()).toBeGreaterThan(attachmentEpochBeforeSubmit!);
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
        const receipt: LocalMessageQueueReceipt = { type: 'queued', sessionId: 'session-1', localIds: ['local-1'] };
        mocks.sendMessage.mockImplementation(() => new Promise((resolve) => {
            resolveQueue = () => resolve(receipt);
        }));
        const retry = renderer.root.findByProps({ testID: 'compose-home-session-hydration-retry' }).props.onPress;
        let retryPromise!: Promise<void>;
        await act(async () => {
            retryPromise = retry();
            await Promise.resolve();
        });

        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.awaitLocalMessageProjection).not.toHaveBeenCalled();
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        expect(renderer.root.findByType('MessageComposer').props.selectedImages).toEqual([
            { id: 'image-a', uri: 'file:///a.png' },
            { id: 'image-b', uri: 'file:///b.png' },
        ]);

        await act(async () => {
            resolveQueue?.();
            await retryPromise;
        });

        expect(mocks.awaitLocalMessageProjection).toHaveBeenCalledWith('session-1', receipt.localIds, receipt);
        expect(mocks.awaitLocalMessageProjection.mock.calls[0][2]).toBe(receipt);
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        expect(renderer.root.findByType('MessageComposer').props.selectedImages).toBeUndefined();
        act(() => renderer.unmount());
    });

    it('finishes queued work after unmount without navigating or clearing newer edits', async () => {
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
        expect(mocks.updatePermission).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.clearImages).not.toHaveBeenCalled();
        expect(mocks.removeImage).not.toHaveBeenCalled();
        expect(consoleErrorSpy.mock.calls.filter((values) => (
            values[0] !== 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer'
        ))).toEqual([]);
    });

    it('keeps recovery saved without restoring text when original attachments are missing', async () => {
        vi.useFakeTimers();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('recover attachments'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); await vi.runAllTimersAsync(); });
        act(() => useComposeDraft.getState().setImages([]));
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-submission' }).props.onPress(); });
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('recover attachments');
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });
    it('does not accept MMKV memory fallback as durable Web storage', async () => {
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('blocked'); } });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('keep unsaved text'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); });
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('keep unsaved text');
        act(() => renderer.unmount());
    });
    it.each([false, true])('explicitly restores durable text without unavailable original attachments (accepted: %s)', async accepted => {
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(accepted);
        mocks.awaitLocalMessageProjection.mockResolvedValue(false);
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('retain original text'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); await vi.runAllTimersAsync(); });
        act(() => useComposeDraft.getState().setImages([]));
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-text-only' }).props.onPress(); });
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-text-only' }).props.onPress(); });
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('retain original text');
        expect(renderer.root.findByType('MessageComposer').props.isSendDisabled).toBe(false);
        const scope = getFirstSubmissionScope()!;
        act(() => { renderer.unmount(); clearComposeDraft(); setFirstSubmissionScope(scope.key, scope.serverUrl); });
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('retain original text');
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(accepted ? 1 : 0);
        act(() => renderer.unmount());
    });
    it('keeps a normal restored text-only submission recoverable after refresh', async () => {
        vi.useFakeTimers(); vi.mocked(Modal.confirm).mockResolvedValue(true);
        let renderer: any;
        act(() => { useComposeDraft.getState().setImages([]); renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('durable restored text'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); await vi.runAllTimersAsync(); });
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-submission' }).props.onPress(); });
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('durable restored text');
        const scope = getFirstSubmissionScope()!;
        const persisted = JSON.parse(globalThis.localStorage.getItem(`first-submission-v1:${scope.key}`)!);
        expect(persisted?.text).toBe('durable restored text');
        act(() => { renderer.unmount(); clearComposeDraft(); setFirstSubmissionScope(scope.key, scope.serverUrl); });
        act(() => { renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        expect(renderer.root.findByProps({ testID: 'compose-home-starting-text' }).props.children).toBe('durable restored text');
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });
    it.each([false, true])('omits only one original while retaining newer same-name selections (refresh fallback: %s)', async refresh => {
        vi.useFakeTimers(); vi.mocked(Modal.confirm).mockResolvedValue(true);
        const original = { id: 'A', name: 'photo.png', uri: 'file:///original.png' } as any;
        const newer = { id: 'B', name: 'photo.png', uri: 'file:///newer.png' } as any;
        const secondNewer = { id: 'C', name: 'photo.png', uri: 'file:///second-newer.png' } as any;
        let renderer: any;
        act(() => { useComposeDraft.getState().setImages([original]); renderer = TestRenderer.create(<ComposeHome variant="screen" />); });
        act(() => renderer.root.findByType('MessageComposer').props.onChangeText('original submission'));
        await act(async () => { renderer.root.findByType('MessageComposer').props.onSend(); await vi.runAllTimersAsync(); });
        act(() => {
            if (refresh) {
                const scope = getFirstSubmissionScope()!;
                setFirstSubmissionScope(scope.key, scope.serverUrl);
            }
            // Put the newer file first so filename matching cannot win over A's exact ID.
            useComposeDraft.getState().setImages(refresh ? [newer, secondNewer] : [newer, original]);
        });
        await act(async () => { await renderer.root.findByProps({ testID: 'compose-home-restore-text-only' }).props.onPress(); });
        expect(useComposeDraft.getState().images.map(image => image.id)).toEqual(refresh ? ['C'] : ['B']);
        expect(renderer.root.findByType('MessageComposer').props.initialValue).toBe('original submission');
        act(() => renderer.unmount());
    });
});
