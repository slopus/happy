vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml', default: 'Svg', Path: 'Path', Rect: 'Rect', Circle: 'Circle' }));
import * as React from 'react';
import { act } from 'react';
import { Platform } from 'react-native';
import { appThemes } from '@/themePacks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    openSettingsRoute: vi.fn(),
    browseDirectory: vi.fn(),
    confirm: vi.fn(),
    readClaudeModels: vi.fn(),
    magpieCatalog: null as any,
    discoverMagpie: false,
    listWorktrees: vi.fn().mockResolvedValue([]),
    modelTriggerFocus: vi.fn(),
    pickerCloseFocus: vi.fn(),
    setEffortLevel: vi.fn(),
    setFastMode: vi.fn(),
    setModelMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setPath: vi.fn(),
    setSessionType: vi.fn(),
    setWorktreeKey: vi.fn(),
    viewport: { width: 390, height: 900 },
    codexAccounts: { loading: false, error: null as string | null, bindings: [] as Array<{ machineId: string; profileId: string | null }> },
    sessionsOverride: null as unknown[] | null,
    cliAvailability: { codex: true } as Record<string, boolean>,
    draftStore: null as any,
    configuredAgents: { mac: ['codex', 'claude'], 'other-mac': ['codex'] } as Record<string, string[]>,
    agentDefaultOverrides: {} as Record<string, { modelMode?: string; effortLevel?: string }>,
}));

vi.mock('./DesktopSettingsModal', () => ({ useDesktopSettingsModal: () => ({ openRoute: mocks.openSettingsRoute }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));

vi.mock('@/hooks/useMagpieModelCatalog', () => ({ useMagpieModelCatalog: () => ({ catalog: mocks.magpieCatalog, refresh: async () => {} }) }));

vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => mocks.codexAccounts }));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>(({ children, ...props }, ref) => {
        const node = ReactModule.useMemo(() => {
            const HTMLElementClass = globalThis.HTMLElement as unknown as new () => object;
            return Object.assign(new HTMLElementClass(), {
                focus: props.testID === 'session-config-picker-close'
                    ? mocks.pickerCloseFocus
                    : props.testID === 'session-config-model-trigger'
                        ? mocks.modelTriggerFocus
                        : vi.fn(),
                isConnected: true,
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                    callback(40, 700, 120, 32);
                },
            });
        }, [props.testID]);
        ReactModule.useImperativeHandle(ref, () => node);
        return ReactModule.createElement(
            'Pressable',
            props,
            typeof children === 'function' ? children({ pressed: false }) : children,
        );
    });
    const Modal = ({ visible, children, ...props }: any) => visible
        ? ReactModule.createElement('Modal', props, children)
        : null;

    return {
        Animated: { Value: class { setValue() {} interpolate() { return 1; } }, View: 'AnimatedView', loop: () => ({ start() {}, stop() {} }), sequence: () => ({}), timing: () => ({}) },
        Easing: { linear: () => ({}) },
        ActivityIndicator: 'ActivityIndicator',
        Image: 'Image',
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        LayoutAnimation: { configureNext: vi.fn(), Presets: { easeInEaseOut: {} } },
        Modal,
        Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
        Pressable,
        ScrollView: 'ScrollView',
        Text: 'Text',
        TextInput: 'TextInput',
        View: 'View',
        useWindowDimensions: () => mocks.viewport,
    };
});
vi.mock('expo-glass-effect', () => ({ GlassView: 'GlassView' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    MaterialCommunityIcons: 'MaterialCommunityIcons',
    Octicons: 'Octicons',
}));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => {
    const machines = [{
        id: 'mac',
        active: true,
        activeAt: Date.now(),
        metadata: {
            displayName: 'Mac mini',
            homeDir: '/Users/test',
            cliAvailability: mocks.cliAvailability,
            get magpieModelCatalog() { return mocks.discoverMagpie ? 1 : undefined; },
        },
    }, {
        id: 'other-mac',
        active: true,
        activeAt: Date.now(),
        metadata: {
            displayName: 'Other Mac',
            homeDir: '/Users/other',
            cliAvailability: { codex: true },
        },
    }];
    const sessions: unknown[] = [{
        id: 'session-1',
        activeAt: 1,
        metadata: {
            flavor: 'codex',
            machineId: 'mac',
            currentModelCode: 'gpt-5.6-sol',
            models: [
                { code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority', name: 'priority' }] },
                { code: 'gpt-5.6-terra', value: 'gpt-5.6-terra', serviceTiers: [{ id: 'priority', name: 'priority' }] },
            ],
        },
    }];
    const settings = {};
    return {
        useAllMachines: () => machines,
        useLocalSetting: () => null,
        useSessions: () => mocks.sessionsOverride ?? sessions,
        useSetting: (name: string) => name === 'codingAgentMachines' ? mocks.configuredAgents
            : name === 'agentDefaultOverrides' ? mocks.agentDefaultOverrides : settings,
    };
});
vi.mock('@/hooks/useNewSessionDraft', async () => {
    const { create } = await import('zustand');
    const { resolveAgentDefaultConfig } = await import('@/sync/agentDefaults');
    const store = create<any>((set, get) => ({
        input: '', selectedMachineId: 'mac', selectedPath: '~/happy', agentType: 'codex',
        permissionMode: 'yolo', modelMode: 'gpt-5.6-sol', effortLevel: 'high', fastMode: false,
        modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
        effortSelection: { agent: 'codex', defaultValue: 'medium' },
        sessionType: 'simple', worktreeKey: null,
        setMachineId: (selectedMachineId: string) => set({ selectedMachineId }),
        setPath: mocks.setPath,
        setAgentType: (agentType: string) => {
            if (agentType !== get().agentType) set({ agentType, modelSelection: undefined, effortSelection: undefined });
        },
        setPermissionMode: (permissionMode: string) => { mocks.setPermissionMode(permissionMode); set({ permissionMode }); },
        setModelMode: (modelMode: string, useMagpie?: boolean) => {
            mocks.setModelMode(modelMode);
            const agent = get().agentType;
            const defaults = resolveAgentDefaultConfig(mocks.agentDefaultOverrides, agent);
            set({ modelMode, useMagpie, modelSelection: { agent, defaultValue: defaults.modelMode } });
        },
        setEffortLevel: (effortLevel: string | null) => {
            mocks.setEffortLevel(effortLevel);
            const agent = get().agentType;
            const defaults = resolveAgentDefaultConfig(mocks.agentDefaultOverrides, agent);
            set({ effortLevel, effortSelection: { agent, defaultValue: defaults.effortLevel } });
        },
        reconcileCodexDefaults: () => {
            const state = get();
            if (state.agentType !== 'codex') return;
            const defaults = resolveAgentDefaultConfig(mocks.agentDefaultOverrides, 'codex');
            const patch: Record<string, unknown> = {};
            if (state.modelSelection && (state.modelSelection.agent !== 'codex'
                || state.modelSelection.defaultValue !== defaults.modelMode)) {
                patch.modelSelection = undefined;
                patch.modelMode = 'default';
            }
            if (state.effortSelection && (state.effortSelection.agent !== 'codex'
                || state.effortSelection.defaultValue !== defaults.effortLevel)) {
                patch.effortSelection = undefined;
                patch.effortLevel = null;
            }
            if (Object.keys(patch).length > 0) set(patch);
        },
        setFastMode: (fastMode: boolean) => { mocks.setFastMode(fastMode); set({ fastMode }); },
        setSessionType: mocks.setSessionType, setWorktreeKey: mocks.setWorktreeKey,
    }));
    mocks.draftStore = store;
    return { useNewSessionDraft: store };
});
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/worktree', () => ({ listWorktrees: mocks.listWorktrees }));
vi.mock('@/sync/ops', () => ({ machineBrowseDirectory: mocks.browseDirectory, machineGetClaudeModelCatalog: mocks.readClaudeModels }));
vi.mock('@/utils/pathUtils', () => ({ resolveAbsolutePath: (path: string) => path }));
vi.mock('@/utils/sessionUtils', () => ({
    formatLastSeen: () => 'now',
    formatPathRelativeToHome: (path: string) => path,
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    const theme = appThemes.ginghamDark;
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

let SessionConfigPanel: typeof import('./SessionConfigPanel').SessionConfigPanel;
let PathPickerContent: typeof import('./SessionConfigPanel').PathPickerContent;
let SessionComposerDirectorySelector: typeof import('./SessionComposerDirectorySelector').SessionComposerDirectorySelector;
let restoreModuleLoad: (() => void) | null = null;

beforeAll(async () => {
    vi.stubGlobal('HTMLElement', class MockHTMLElement {});
    vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        cancelAnimationFrame: vi.fn(),
        removeEventListener: vi.fn(),
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        },
    });
    const NodeModule = (await import('node:module')).default as any;
    const originalLoad = NodeModule._load;
    NodeModule._load = function load(request: string, ...args: unknown[]) {
        if (request.startsWith('@/assets/images/icon-') || request === '@/assets/images/paws-mascot.png') return {};
        return originalLoad.call(this, request, ...args);
    };
    restoreModuleLoad = () => { NodeModule._load = originalLoad; };
    ({ SessionConfigPanel, PathPickerContent } = await import('./SessionConfigPanel'));
    ({ SessionComposerDirectorySelector } = await import('./SessionComposerDirectorySelector'));
});

afterAll(() => {
    restoreModuleLoad?.();
    vi.unstubAllGlobals();
});

describe('SessionConfigPanel composer layout', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (Platform as { OS: string }).OS = 'web';
        mocks.viewport.width = 1440;
        mocks.viewport.height = 900;
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.readClaudeModels.mockReset().mockRejectedValue(new Error('Old runtime'));
        mocks.codexAccounts = { loading: false, error: null, bindings: [] };
        mocks.sessionsOverride = null;
        mocks.magpieCatalog = null;
        mocks.discoverMagpie = false;
        for (const key of Object.keys(mocks.cliAvailability)) delete mocks.cliAvailability[key];
        mocks.cliAvailability.codex = true;
        mocks.configuredAgents = { mac: ['codex', 'claude'], 'other-mac': ['codex'] };
        mocks.agentDefaultOverrides = {};
        mocks.draftStore.setState({ useMagpie: undefined, modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
            effortSelection: { agent: 'codex', defaultValue: 'medium' }, input: '', selectedMachineId: 'mac', selectedPath: '~/happy', agentType: 'codex', permissionMode: 'yolo', modelMode: 'gpt-5.6-sol', effortLevel: 'high', fastMode: false, sessionType: 'simple', worktreeKey: null });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        (Platform as { OS: string }).OS = 'web';
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
    });

    it('dismisses sidebar pickers outside while allowing the current trigger to toggle closed', async () => {
        const listeners = new Map<string, (event: any) => void>();
        const ElementClass = globalThis.HTMLElement as any;
        ElementClass.prototype.contains = function(target: unknown) { return this === target; };
        vi.stubGlobal('Node', ElementClass);
        vi.stubGlobal('document', {
            addEventListener: (name: string, listener: any) => listeners.set(name, listener),
            removeEventListener: (name: string) => listeners.delete(name),
        });
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="sidebar" collapsible={false} />); });
            const trigger = Object.assign(new ElementClass(), { contains: (target: any) => target === trigger });
            const findTrigger = () => renderer.root.findByProps({ testID: 'session-config-path-trigger' });
            act(() => findTrigger().props.onPress({ currentTarget: trigger }));
            expect(renderer.root.findAllByProps({ testID: 'session-config-inline-picker-path' })).toHaveLength(1);
            act(() => listeners.get('pointerdown')?.({ button: 0, target: trigger }));
            expect(renderer.root.findAllByProps({ testID: 'session-config-inline-picker-path' })).toHaveLength(1);
            act(() => findTrigger().props.onPress({ currentTarget: trigger }));
            expect(renderer.root.findAllByProps({ testID: 'session-config-inline-picker-path' })).toHaveLength(0);
            act(() => findTrigger().props.onPress({ currentTarget: trigger }));
            act(() => listeners.get('pointerdown')?.({ button: 0, target: new ElementClass() }));
            expect(renderer.root.findAllByProps({ testID: 'session-config-inline-picker-path' })).toHaveLength(0);
        } finally {
            if (renderer) act(() => renderer.unmount()); renderer = undefined;
            delete ElementClass.prototype.contains;
            vi.stubGlobal('document', undefined); vi.stubGlobal('Node', undefined);
        }
    });

    it('keeps agent settings out of the model popup while retaining direct agent selection', async () => {
        mocks.cliAvailability.claude = true;
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-agent-manage' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-composer-agent-menu' })).toHaveLength(0);
        await act(async () => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-composer-agent-menu' })).toBeDefined();
        expect(mocks.openSettingsRoute).not.toHaveBeenCalled();
    });

    it('shows configuration instead of a disabled model picker when no agents are enabled', async () => {
        mocks.configuredAgents = { mac: [] };
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-configure-agents' }).props.onPress());
        expect(mocks.openSettingsRoute).toHaveBeenCalledWith('/settings/coding-agents', { machineId: 'mac' });
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-selector' })).toHaveLength(0);
    });

    it('uses the actual worktree and keeps CLI automatic as an explicit send choice', async () => {
        mocks.cliAvailability.claude = true;
        mocks.draftStore.setState({ agentType: 'claude', modelMode: 'sonnet', selectedPath: '/parent', worktreeKey: '/parent--task' });
        mocks.readClaudeModels.mockResolvedValue({ source: 'claude-native', observedAt: 1, models: [
            { code: 'default', value: 'CLI automatic' }, { code: 'opus', value: 'Live Opus' }, { code: 'sonnet', value: 'Live Sonnet' },
        ] });
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />); });
        expect(mocks.readClaudeModels).toHaveBeenCalledWith('mac', '/parent--task');
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        await act(async () => { renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress(); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-claude::default' }).props.onPress());
        expect(ref.current.getSelection().modelKey).toBeUndefined();
    });

    it('retains a verified explicit choice only on its original connection when a catalog removes it', async () => {
        mocks.cliAvailability.claude = true;
        mocks.draftStore.setState({ agentType: 'claude', modelMode: 'vendor/custom', selectedPath: '/one' });
        mocks.readClaudeModels.mockResolvedValueOnce({ source: 'claude-native', observedAt: 1, models: [{ code: 'vendor/custom', value: 'Custom' }] })
            .mockResolvedValue({ source: 'claude-native', observedAt: 2, models: [{ code: 'opus', value: 'Live Opus' }] });
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        await act(async () => { renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress(); });
        expect(ref.current.getSelection().modelKey).toBe('vendor/custom');
        await act(async () => { mocks.draftStore.setState({ selectedPath: '/two' }); });
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-claude::vendor/custom' })).toHaveLength(0);
        expect(ref.current.getSelection().modelKey).toBe('opus');
        expect(ref.current.getSelection().modelUnavailable).toBe(true);
    });

    it('discovers native Claude models without an earlier session and refreshes the displayed catalog', async () => {
        mocks.cliAvailability.claude = true;
        mocks.draftStore.setState({ agentType: 'claude', modelMode: 'opus', selectedPath: '/Users/test/happy' });
        mocks.readClaudeModels.mockResolvedValueOnce({ source: 'claude-native', observedAt: 1, models: [
            { code: 'opus', value: 'Live Opus', supportedEffortLevels: ['medium'] },
        ] }).mockResolvedValueOnce({ source: 'claude-native', observedAt: 2, models: [
            { code: 'opus', value: 'New Opus', supportedEffortLevels: ['medium'] },
            { code: 'vendor/future', value: 'Future model', supportedEffortLevels: ['high'] },
        ] });
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />); });
        expect(mocks.readClaudeModels).toHaveBeenCalledWith('mac', '/Users/test/happy');
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        await act(async () => { renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress(); });
        expect(renderer.root.findByProps({ testID: 'session-composer-model-claude::vendor/future' }).props.accessibilityLabel).toBe('Future model');
        expect(renderer.root.findByProps({ testID: 'session-composer-model-claude::opus' }).props.accessibilityLabel).toBe('New Opus');
    });

    it('selects available coding agents directly, scopes models, and updates live send settings', async () => {
        mocks.cliAvailability.claude = true;
        mocks.cliAvailability.gemini = false;
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const modelList = () => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress();
        const agentMenu = () => renderer.root.findByProps({ testID: 'session-composer-agent-menu' });
        expect(renderer.root.findAllByProps({ testID: 'session-composer-effort-reset' })).toHaveLength(0);
        await act(async () => modelList());
        expect(agentMenu().props.accessibilityHint).toBe('Codex');
        act(() => agentMenu().props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-agent-gemini' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'session-composer-agent-claude' }).props.onPress());
        expect(mocks.draftStore.getState().agentType).toBe('claude');
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'opus', effortKey: 'high', fastMode: false });
        await act(async () => modelList());
        expect(agentMenu().props.accessibilityHint).toBe('Claude Code');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::gpt-5.6-sol' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-claude::sonnet' }).props.onPress());
        expect(mocks.draftStore.getState().agentType).toBe('claude');
        expect(ref.current.getSelection().modelKey).toBe('sonnet');
        await act(async () => modelList());
        act(() => agentMenu().props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-agent-codex' }).props.onPress());
        expect(mocks.draftStore.getState().agentType).toBe('codex');
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-sol');
        await act(async () => modelList());
        expect(agentMenu().props.accessibilityHint).toBe('Codex');
    });

    it('preserves a Magpie model shared by two agents without changing agent from model selection', async () => {
        mocks.discoverMagpie = true;
        mocks.magpieCatalog = { modelsUpdatedAt: 1, models: [{ code: 'foreign-gateway', value: 'Foreign Gateway' }] };
        mocks.cliAvailability.claude = true;
        mocks.readClaudeModels.mockResolvedValue({ source: 'claude-native', observedAt: 1,
            models: [{ code: 'gpt-5.6-sol', value: 'Magpie GPT' }, { code: 'opus', value: 'Opus' }] });
        mocks.sessionsOverride = [{ id: 'claude-session', activeAt: 2, metadata: {
            flavor: 'claude', machineId: 'mac', currentModelCode: 'gpt-5.6-sol',
            models: [{ code: 'gpt-5.6-sol', value: 'Magpie GPT' }, { code: 'opus', value: 'Opus' }],
        } }];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-agent-menu' }).props.onPress());
        await act(async () => { renderer.root.findByProps({ testID: 'session-composer-agent-claude' }).props.onPress(); });
        expect(mocks.draftStore.getState().agentType).toBe('claude');
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-sol');
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-magpie::foreign-gateway' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-claude::gpt-5.6-sol' }).props.onPress());
        expect(mocks.draftStore.getState().agentType).toBe('claude');
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-sol');
    });

    it('opens one grouped list and retains the Magpie route and model during a directory change', async () => {
        mocks.discoverMagpie = true;
        mocks.codexAccounts.bindings = [{ machineId: 'mac', profileId: 'managed' }];
        mocks.sessionsOverride = [{ id: 'managed', activeAt: 10, metadata: { machineId: 'mac', flavor: 'codex',
            codexAccountProfileId: 'managed', models: [{ code: 'gpt-5.6-sol', value: 'GPT-5.6 Sol' }] } }];
        const gateway = { code: 'openrouter/google/gemini-4-argon', value: 'Gemini 4 Argon', supportedEffortLevels: ['high'], serviceTiers: [] };
        mocks.magpieCatalog = { models: [gateway], modelsUpdatedAt: 1 };
        const ref = React.createRef<any>();
        const tree = () => <SessionConfigPanel ref={ref} layout="composer" />;
        await act(async () => { renderer = TestRenderer.create(tree()); });
        await act(async () => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-search' })).toHaveLength(0);
        await act(async () => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-composer-model-group-GPT' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-composer-model-group-Gemini' })).toBeDefined();
        act(() => renderer.root.findByProps({ testID: `session-composer-model-magpie::${gateway.code}` }).props.onPress());
        expect(ref.current.getSelection()).toMatchObject({ modelKey: gateway.code, magpieModel: gateway.code, effortKey: 'high', expectedCodexAccountProfileId: null });
        mocks.magpieCatalog = null;
        await act(async () => { renderer.update(tree()); });
        expect(ref.current.getSelection()).toMatchObject({ modelUnavailable: true, modelKey: gateway.code });
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.accessibilityLabel).toContain(gateway.code);
        expect(mocks.draftStore.getState().modelMode).toBe(gateway.code);
    });

    it('keeps the selected model identity when the connection catalog is reordered', async () => {
        const models = [
            { code: 'gpt-5.6-sol', value: 'Sol' },
            { code: 'gpt-5.6-terra', value: 'Terra' },
        ];
        mocks.sessionsOverride = [{ id: 'native', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', models,
        } }];
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />);
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::default' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-codex::gpt-5.6-terra' }).props.onPress());
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-terra');
        mocks.sessionsOverride = [{ id: 'native', activeAt: 21, metadata: {
            machineId: 'mac', flavor: 'codex', models: [...models].reverse(),
        } }];
        act(() => renderer.update(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />));
        // Persisted user intent and the visible selection must keep the model code
        // rather than following its old array position.
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-terra');
    });

    it.each(['low', 'high', 'xhigh', 'max'])('preserves %s effort while the Codex connection catalog hydrates', async (effort) => {
        mocks.draftStore.setState({ effortLevel: effort });
        mocks.sessionsOverride = [];
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />);
        });
        expect(mocks.draftStore.getState().effortLevel).toBe(effort);
        expect(ref.current.getSelection().effortKey).toBeNull();
        mocks.sessionsOverride = [{ id: 'hydrated', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', currentModelCode: 'gpt-5.6-sol',
            models: [{ code: 'gpt-5.6-sol', value: 'Sol' }],
            thoughtLevels: ['low', 'medium', 'high', 'xhigh', 'max'].map(code => ({ code, value: code })),
        } }];
        await act(async () => renderer.update(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />));
        expect(ref.current.getSelection().effortKey).toBe(effort);
    });

    it('ignores legacy Codex model and effort values without user-selection snapshots', async () => {
        mocks.agentDefaultOverrides = { codex: { modelMode: 'gpt-6-astra', effortLevel: 'ultra' } };
        mocks.draftStore.setState({ modelMode: 'gpt-5.6-sol', effortLevel: 'high',
            modelSelection: undefined, effortSelection: undefined });
        mocks.sessionsOverride = [{ id: 'catalog', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', currentModelCode: 'gpt-6-astra',
            models: [{ code: 'gpt-5.6-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }],
            thoughtLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(code => ({ code, value: code })),
        } }];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-6-astra', effortKey: 'ultra' });
        expect(mocks.draftStore.getState()).toMatchObject({ modelMode: 'gpt-5.6-sol', effortLevel: 'high' });
        expect(mocks.draftStore.getState().modelSelection).toBeUndefined();
        expect(mocks.draftStore.getState().effortSelection).toBeUndefined();
        expect(mocks.setModelMode).not.toHaveBeenCalled();
        expect(mocks.setEffortLevel).not.toHaveBeenCalled();
    });

    it('follows changed defaults at send time and preserves fresh user picks across remounts', async () => {
        mocks.sessionsOverride = [{ id: 'catalog', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', currentModelCode: 'gpt-6-astra',
            models: [{ code: 'gpt-5.6-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }],
            thoughtLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(code => ({ code, value: code })),
        } }];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-5.6-sol', effortKey: 'high' });

        mocks.agentDefaultOverrides = { codex: { modelMode: 'gpt-6-astra', effortLevel: 'ultra' } };
        await act(async () => renderer.update(<SessionConfigPanel ref={ref} layout="composer" />));
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-6-astra', effortKey: 'ultra' });
        expect(mocks.setModelMode).not.toHaveBeenCalled();
        expect(mocks.setEffortLevel).not.toHaveBeenCalled();

        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-codex::gpt-5.6-sol' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-effort-low' }).props.onPress());
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-5.6-sol', effortKey: 'low' });
        expect(mocks.draftStore.getState()).toMatchObject({
            modelSelection: { agent: 'codex', defaultValue: 'gpt-6-astra' },
            effortSelection: { agent: 'codex', defaultValue: 'ultra' },
        });
        expect(mocks.setModelMode).toHaveBeenCalledTimes(1);
        expect(mocks.setEffortLevel).toHaveBeenCalledTimes(1);
        await act(async () => renderer.unmount());
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-5.6-sol', effortKey: 'low' });

        // A change to only the effort default must not erase the independent model pick.
        mocks.agentDefaultOverrides = { codex: { modelMode: 'gpt-6-astra', effortLevel: 'medium' } };
        await act(async () => renderer.update(<SessionConfigPanel ref={ref} layout="composer" />));
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-5.6-sol', effortKey: 'medium' });
        expect(mocks.setModelMode).toHaveBeenCalledTimes(1);
        expect(mocks.setEffortLevel).toHaveBeenCalledTimes(1);
    });

    it('retains the explicit CLI model reset label and send sentinel after catalog hydration', async () => {
        mocks.draftStore.setState({ modelMode: 'default', effortLevel: 'default' });
        mocks.sessionsOverride = [];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(ref.current.getSelection().modelKey).toBeUndefined();
        mocks.sessionsOverride = [{ id: 'catalog', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', currentModelCode: 'gpt-6-astra',
            models: [{ code: 'gpt-5.6-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }],
            thoughtLevels: ['medium', 'high', 'ultra'].map(code => ({ code, value: code })),
        } }];
        await act(async () => renderer.update(<SessionConfigPanel ref={ref} layout="composer" />));
        expect(ref.current.getSelection().modelKey).toBeUndefined();
        expect(ref.current.getSelection().effortKey).toBe('default');
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.accessibilityLabel)
            .toContain('agentInput.model.cliAutomatic');
        expect(mocks.setModelMode).not.toHaveBeenCalled();
        expect(mocks.setEffortLevel).not.toHaveBeenCalled();
    });

    it('keeps an explicit native effort reset with a concrete selected model', async () => {
        mocks.draftStore.setState({ effortLevel: 'default' });
        mocks.sessionsOverride = [{ id: 'catalog', activeAt: 20, metadata: {
            machineId: 'mac', flavor: 'codex', currentModelCode: 'gpt-5.6-sol',
            models: [{ code: 'gpt-5.6-sol', value: 'Sol' }],
            thoughtLevels: ['low', 'medium', 'high', 'ultra'].map(code => ({ code, value: code })),
        } }];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(ref.current.getSelection()).toMatchObject({ modelKey: 'gpt-5.6-sol', effortKey: 'default' });
        expect(mocks.setModelMode).not.toHaveBeenCalled();
        expect(mocks.setEffortLevel).not.toHaveBeenCalled();
    });

    it('retains an explicit agent launch entry when no model catalog exists', async () => {
        mocks.sessionsOverride = [];
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" collapsible={false} />);
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        const launch = renderer.root.findByProps({ testID: 'session-composer-model-codex::default' });
        expect(launch.props.accessibilityLabel).toContain('agentInput.model.cliAutomatic');
        expect(launch.props.accessibilityLabel).not.toContain('default model');
        act(() => launch.props.onPress());
        expect(mocks.setModelMode).toHaveBeenCalledWith('default');
        expect(ref.current.getSelection().modelKey).toBeUndefined();
        expect(ref.current.getSelection().effortKey).toBeNull();
    });

    it('keeps every editable new-session setting in the composer footer', async () => {
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(
                <SessionConfigPanel ref={ref} layout="composer" collapsible={false} />,
            );
            await Promise.resolve();
        });

        expect(renderer.root.findByProps({ testID: 'new-session-composer-config' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-machine-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-path-trigger' })).toBeDefined();
        expect(renderer.root.findAllByProps({ testID: 'session-config-agent-trigger' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-config-worktree-trigger' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'session-composer-permission-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-trigger' })).toBeDefined();
        expect(renderer.root.findAllByProps({ testID: 'session-config-model-trigger' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-config-effort-trigger' })).toHaveLength(0);
        expect(mocks.listWorktrees).not.toHaveBeenCalled();
        const controls = renderer.root.findByProps({ testID: 'new-session-composer-config-controls' });
        expect(controls.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-model-codex::gpt-5.6-terra' }).props.onPress());
        expect(mocks.setModelMode).toHaveBeenCalledWith('gpt-5.6-terra');
        expect(mocks.setEffortLevel).not.toHaveBeenCalledWith(null);
        expect(ref.current.getSelection().effortKey).toBe('high');
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-terra');
        act(() => renderer.root.findByProps({ testID: 'session-composer-fast-toggle' }).props.onPress());
        expect(ref.current.getSelection().fastMode).toBe(true);
        expect(mocks.setFastMode).toHaveBeenCalledWith(true);
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-picker-scrim' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-permission-trigger' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: 'session-composer-permission-option-automatic' }).props.onPress());
        expect(mocks.setPermissionMode).toHaveBeenCalledWith('safe-yolo');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-permission-more' })).toHaveLength(0);


    });

    it('resets a source Claude grant when the regular Agent picker creates an agy draft', async () => {
        mocks.cliAvailability.claude = true;
        mocks.cliAvailability.antigravity = true;
        mocks.configuredAgents.mac = ['claude', 'antigravity'];
        mocks.draftStore.setState({ agentType: 'claude', permissionMode: 'bypassPermissions', modelMode: 'default' });
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="inline" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-config-agent-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ accessibilityLabel: 'Antigravity' }).props.onPress());
        expect(mocks.draftStore.getState().agentType).toBe('antigravity');
        expect(mocks.draftStore.getState().permissionMode).toBe('default');
    });

    it('also resets source permissions when machine availability automatically falls back to agy', async () => {
        mocks.cliAvailability.antigravity = true;
        mocks.configuredAgents.mac = ['antigravity'];
        mocks.draftStore.setState({ agentType: 'claude', permissionMode: 'bypassPermissions', modelMode: 'default' });
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="inline" collapsible={false} />); });
        expect(mocks.draftStore.getState().agentType).toBe('antigravity');
        expect(mocks.draftStore.getState().permissionMode).toBe('default');
    });

    it('requires an explicit risk confirmation before a new agy draft can select full access', async () => {
        mocks.cliAvailability.antigravity = true;
        mocks.configuredAgents.mac = ['antigravity'];
        mocks.draftStore.setState({ agentType: 'antigravity', permissionMode: 'default', modelMode: 'default' });
        mocks.confirm.mockResolvedValue(false);
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-permission-trigger' }).props.onPress());
        await act(async () => { await renderer.root.findByProps({ testID: 'session-composer-permission-option-full-access' }).props.onPress(); });
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.draftStore.getState().permissionMode).toBe('default');
    });

    it('scopes both the picker and send selection to the machine account binding', async () => {
        mocks.sessionsOverride = [
            { id: 'account', activeAt: 10, metadata: { machineId: 'mac', flavor: 'codex',
                codexAccountProfileId: 'account-a', models: [{ code: 'gpt-5.6-sol', value: 'Sol' }] } },
            { id: 'native', activeAt: 20, metadata: { machineId: 'mac', flavor: 'codex',
                models: [{ code: 'deepseek/DeepSeek-V4.1-Flash', value: 'DeepSeek' }] } },
        ];
        mocks.codexAccounts.bindings = [{ machineId: 'mac', profileId: 'account-a' }];
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::deepseek/DeepSeek-V4.1-Flash' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::gpt-5.6-sol' }).length).toBeGreaterThan(0);
        expect(ref.current.getSelection().modelKey).toBe('gpt-5.6-sol');
        expect(ref.current.getSelection().expectedCodexAccountProfileId).toBe('account-a');

        mocks.codexAccounts.bindings = [];
        await act(async () => { renderer.update(<SessionConfigPanel ref={ref} layout="composer" />); });
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-panel' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::deepseek/DeepSeek-V4.1-Flash' }).length).toBeGreaterThan(0);
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::gpt-5.6-sol' })).toHaveLength(0);
        expect(ref.current.getSelection().expectedCodexAccountProfileId).toBeNull();
    });

    it.each([
        { loading: true, error: null },
        { loading: false, error: 'network-error' },
    ])('does not offer native models while the binding is unknown: %j', async (status) => {
        mocks.sessionsOverride = [{ id: 'native', activeAt: 20, metadata: { machineId: 'mac', flavor: 'codex',
            models: [{ code: 'deepseek/DeepSeek-V4.1-Flash', value: 'DeepSeek' }] } }];
        mocks.codexAccounts = { ...status, bindings: [] };
        const ref = React.createRef<any>();
        await act(async () => { renderer = TestRenderer.create(<SessionConfigPanel ref={ref} layout="composer" />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::deepseek/DeepSeek-V4.1-Flash' })).toHaveLength(0);
        expect(ref.current.getSelection().modelKey).toBeUndefined();
        expect(ref.current.getSelection().effortKey).toBeNull();
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-codex::gpt-6.1-sol' })).toHaveLength(0);
    });

    it('keeps the current model label when it is the only model but effort is editable', async () => {
        // Exercised through a single-option selector because the provider controls the catalog.
        const { SessionComposerModeSelector } = await import('./SessionComposerModeSelector');
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector online
            model={{ key: 'only', name: 'Only model' }} modelOptions={[{ key: 'only', name: 'Only model' }]}
            effort={{ key: 'high', name: 'high' }} effortOptions={[{ key: 'high', name: 'high' }, { key: 'low', name: 'low' }]}
            onModelChange={vi.fn()} onEffortChange={vi.fn()} />); });
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.accessibilityLabel).toContain('Only model');
    });

    it('opens the Android folder browser in a modal and closes it after choosing a folder', async () => {
        (Platform as { OS: string }).OS = 'android';
        mocks.viewport.width = 390;
        mocks.viewport.height = 420;
        mocks.browseDirectory.mockResolvedValue({
            success: true,
            path: '/Users/test/happy',
            home: '/Users/test',
            directories: [{ name: 'app', path: '/Users/test/happy/app', isProjectRoot: false }],
        });
        await act(async () => {
            renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />);
            await Promise.resolve();
        });

        act(() => renderer.root.findByProps({ testID: 'session-config-path-trigger' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-config-picker-path' }).props.accessibilityViewIsModal).toBe(true);
        expect(renderer.root.findByType('KeyboardAvoidingView').props.behavior).toBe('height');
        expect(renderer.root.findAllByProps({ testID: 'session-config-inline-picker-path' })).toHaveLength(0);

        await act(async () => {
            renderer.root.findByProps({ testID: 'path-picker-browse' }).props.onPress();
            await Promise.resolve();
        });
        const selectFolder = renderer.root.findByProps({ testID: 'path-picker-select-current' });
        let ancestor = selectFolder.parent;
        let scrollsWithShortScreen = false;
        while (ancestor && ancestor.props.testID !== 'session-config-picker-path') {
            if (ancestor.type === 'ScrollView' && ancestor.props.nestedScrollEnabled) {
                scrollsWithShortScreen = true;
            }
            ancestor = ancestor.parent;
        }
        expect(scrollsWithShortScreen).toBe(true);
        act(() => selectFolder.props.onPress());
        expect(mocks.setPath).toHaveBeenCalledWith('/Users/test/happy');
        expect(renderer.root.findAllByProps({ testID: 'session-config-picker-path' })).toHaveLength(0);
    });


    it.each(['web', 'android'])('selects an external project from the location picker on %s', async (platform) => {
        (Platform as { OS: string }).OS = platform;
        const volume = '/Volumes/External SSD';
        const project = `${volume}/Development/demo`;
        const roots = [
            { name: '~', path: '/Users/test', kind: 'home' },
            { name: 'External SSD', path: volume, kind: 'volume' },
        ];
        const onChange = vi.fn();
        mocks.browseDirectory.mockImplementation(async (_machine: string, path: string) => ({
            success: true, home: '/Users/test', roots,
            root: path.startsWith(volume) ? volume : '/Users/test',
            path: path || '/Users/test',
            directories: path === volume ? [{ name: 'demo', path: project, isProjectRoot: true }] : [],
        }));
        await act(async () => {
            renderer = TestRenderer.create(<PathPickerContent title="Directory" items={[]} value="" homeDir="/Users/test" machineId="mac" machineOnline manualInput={false} onChangeValue={onChange} />);
        });
        await act(async () => renderer.root.findByProps({ testID: 'path-picker-browse' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: `directory-root-${volume}` }).props.onPress());
        expect(mocks.browseDirectory).toHaveBeenLastCalledWith('mac', volume);
        const location = renderer.root.findByProps({ testID: `directory-root-${volume}` });
        expect(location.props.style({ pressed: false })[0].backgroundColor).toBe(appThemes.ginghamDark.colors.surface);
        expect(location.props.style({ pressed: false })[1].backgroundColor).toBe(appThemes.ginghamDark.colors.surfaceSelected);
        expect(location.props.style({ pressed: true })[2].backgroundColor).toBe(appThemes.ginghamDark.colors.surfacePressed);
        expect(renderer.root.findAllByProps({ testID: 'path-picker-crumb-/' })).toHaveLength(0);
        await act(async () => renderer.root.findByProps({ testID: `path-picker-directory-${project}` }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'path-picker-select-current' }).props.onPress());
        expect(onChange).toHaveBeenCalledWith(project);
    });

    it('clears stale selections after a failed navigation and lets the user return home', async () => {
        const volume = '/Volumes/External SSD';
        const roots = [
            { name: '~', path: '/Users/test', kind: 'home' },
            { name: 'External SSD', path: volume, kind: 'volume' },
        ];
        const onChange = vi.fn();
        mocks.browseDirectory.mockResolvedValueOnce({ success: true, path: '/Users/test', home: '/Users/test', roots, directories: [] });
        mocks.browseDirectory.mockResolvedValueOnce({ success: false, error: 'Drive disconnected', roots: roots.slice(0, 1) });
        mocks.browseDirectory.mockResolvedValueOnce({ success: true, path: '/Users/test', home: '/Users/test', roots: roots.slice(0, 1), directories: [] });
        await act(async () => {
            renderer = TestRenderer.create(<PathPickerContent title="Directory" items={[]} value="" machineId="mac" machineOnline onChangeValue={onChange} />);
        });
        await act(async () => renderer.root.findByProps({ testID: 'path-picker-browse' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: `directory-root-${volume}` }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'path-picker-select-current' })).toHaveLength(0);
        expect(onChange).not.toHaveBeenCalled();
        await act(async () => renderer.root.findByProps({ testID: 'directory-root-/Users/test' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'path-picker-select-current' })).toBeDefined();
    });

    it('uses mounted-volume locations when changing an existing session directory', async () => {
        const volume = '/Volumes/External SSD';
        const roots = [
            { name: '~', path: '/Users/test', kind: 'home' },
            { name: 'External SSD', path: volume, kind: 'volume' },
        ];
        const onSwitch = vi.fn().mockResolvedValue({ success: true });
        mocks.browseDirectory.mockImplementation(async (_machine: string, path: string) => ({
            success: true, path, home: '/Users/test', roots, parent: null, directories: [],
        }));
        await act(async () => {
            renderer = TestRenderer.create(<SessionComposerDirectorySelector currentPath="/Users/test" currentPathLabel="~" machineId="mac" machineOnline recentPaths={[]} switching={false} onSwitch={onSwitch} onInvalidStateChange={vi.fn()} />);
        });
        act(() => renderer.root.findByProps({ testID: 'session-working-directory-trigger' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: 'session-working-directory-browse' }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: `directory-root-${volume}` }).props.onPress());
        await act(async () => renderer.root.findByProps({ testID: 'session-working-directory-use-current' }).props.onPress());
        expect(onSwitch).toHaveBeenCalledWith(volume);
    });

    it('ignores a late directory response from the previous machine', async () => {
        let resolveOld!: (value: unknown) => void;
        mocks.browseDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
        mocks.browseDirectory.mockResolvedValueOnce({ success: true, path: '/Users/other', home: '/Users/other', directories: [] });
        const onChange = vi.fn();
        const picker = (machineId: string) => <PathPickerContent title="Directory" items={[]} value="" machineId={machineId} machineOnline onChangeValue={onChange} />;
        await act(async () => { renderer = TestRenderer.create(picker('mac')); });
        act(() => renderer.root.findByProps({ testID: 'path-picker-browse' }).props.onPress());
        await act(async () => renderer.update(picker('other-mac')));
        await act(async () => renderer.root.findByProps({ testID: 'path-picker-browse' }).props.onPress());
        await act(async () => resolveOld({ success: true, path: '/Volumes/Old machine SSD', directories: [] }));
        act(() => renderer.root.findByProps({ testID: 'path-picker-select-current' }).props.onPress());
        expect(onChange).toHaveBeenCalledWith('/Users/other');
    });

    it('opens the unified model panel on Android and closes it on Back', async () => {
        (Platform as { OS: string }).OS = 'android';
        await act(async () => {
            renderer = TestRenderer.create(<SessionConfigPanel layout="composer" collapsible={false} />);
            await Promise.resolve();
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-panel' })).toBeDefined();
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-panel' })).toHaveLength(0);
    });

    it('clears a selected worktree when its machine or project scope changes', async () => {
        mocks.listWorktrees.mockResolvedValue([{ path: '/Users/test/happy--old', branch: 'old-branch' }]);
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(
                <SessionConfigPanel ref={ref} layout="inline" collapsible={false} />,
            );
            await Promise.resolve();
        });

        await act(async () => {
            renderer.root.findByProps({ testID: 'session-config-worktree-trigger' }).props.onPress();
            await Promise.resolve();
        });
        act(() => renderer.root.findByProps({ accessibilityLabel: 'old-branch, /Users/test/happy--old' }).props.onPress());
        expect(ref.current.getSelection().worktreeKey).toBe('/Users/test/happy--old');

        act(() => renderer.root.findByProps({ testID: 'session-config-machine-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ accessibilityLabel: 'Other Mac, status.online' }).props.onPress());
        expect(ref.current.getSelection().worktreeKey).toBe('__none__');

        await act(async () => {
            renderer.root.findByProps({ testID: 'session-config-worktree-trigger' }).props.onPress();
            await Promise.resolve();
        });
        act(() => renderer.root.findByProps({ accessibilityLabel: 'old-branch, /Users/test/happy--old' }).props.onPress());
        expect(ref.current.getSelection().worktreeKey).toBe('/Users/test/happy--old');

        act(() => renderer.root.findByProps({ testID: 'session-config-path-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ accessibilityLabel: 'Project' }).props.onChangeText('/Users/test/new-project'));
        expect(ref.current.getSelection().worktreeKey).toBe('__none__');
    });
});
