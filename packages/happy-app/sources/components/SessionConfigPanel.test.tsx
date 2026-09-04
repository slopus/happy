import * as React from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    modelTriggerFocus: vi.fn(),
    pickerCloseFocus: vi.fn(),
    setEffortLevel: vi.fn(),
    setModelMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setSessionType: vi.fn(),
    setWorktreeKey: vi.fn(),
}));

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
        ActivityIndicator: 'ActivityIndicator',
        Image: 'Image',
        LayoutAnimation: { configureNext: vi.fn(), Presets: { easeInEaseOut: {} } },
        Modal,
        Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
        Pressable,
        ScrollView: 'ScrollView',
        Text: 'Text',
        TextInput: 'TextInput',
        View: 'View',
        useWindowDimensions: () => ({ width: 1440, height: 900 }),
    };
});
vi.mock('expo-glass-effect', () => ({ GlassView: 'GlassView' }));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    MaterialCommunityIcons: 'MaterialCommunityIcons',
    Octicons: 'Octicons',
}));
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
            cliAvailability: { codex: true },
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
        useSessions: () => sessions,
        useSetting: () => settings,
    };
});
vi.mock('@/hooks/useNewSessionDraft', async () => {
    const ReactModule = await import('react');
    const state = {
        input: '',
        selectedMachineId: 'mac',
        selectedPath: '~/happy',
        agentType: 'codex',
        permissionMode: 'yolo',
        modelMode: 'gpt-5.6-sol',
        effortLevel: 'high',
        sessionType: 'simple',
        worktreeKey: null,
        setMachineId: vi.fn(),
        setPath: vi.fn(),
        setAgentType: vi.fn(),
        setPermissionMode: mocks.setPermissionMode,
        setModelMode: mocks.setModelMode,
        setEffortLevel: mocks.setEffortLevel,
        setSessionType: mocks.setSessionType,
        setWorktreeKey: mocks.setWorktreeKey,
    };
    return {
        useNewSessionDraft: (selector: (value: typeof state) => unknown) => {
            const selected = ReactModule.useRef<{ initialized: boolean; value: unknown }>({ initialized: false, value: undefined });
            if (!selected.current.initialized) {
                selected.current = { initialized: true, value: selector(state) };
            }
            return selected.current.value;
        },
    };
});
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/worktree', () => ({ listWorktrees: mocks.listWorktrees }));
vi.mock('@/sync/ops', () => ({ machineBrowseDirectory: vi.fn() }));
vi.mock('@/utils/pathUtils', () => ({ resolveAbsolutePath: (path: string) => path }));
vi.mock('@/utils/sessionUtils', () => ({
    formatLastSeen: () => 'now',
    formatPathRelativeToHome: (path: string) => path,
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            accent: '#08f',
            button: {
                primary: { background: '#08f', tint: '#fff' },
                secondary: { tint: '#555' },
            },
            divider: '#ddd',
            header: { background: '#fff' },
            input: { background: '#fff' },
            shadow: { color: '#000', opacity: 0.2 },
            status: { connected: '#0a0', disconnected: '#a00' },
            surface: '#fff',
            surfaceHigh: '#f2f2f2',
            surfacePressed: '#e8e8e8',
            text: '#111',
            textSecondary: '#666',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

let SessionConfigPanel: typeof import('./SessionConfigPanel').SessionConfigPanel;
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
        if (request.startsWith('@/assets/images/icon-')) return {};
        return originalLoad.call(this, request, ...args);
    };
    restoreModuleLoad = () => { NodeModule._load = originalLoad; };
    ({ SessionConfigPanel } = await import('./SessionConfigPanel'));
});

afterAll(() => {
    restoreModuleLoad?.();
    vi.unstubAllGlobals();
});

describe('SessionConfigPanel composer layout', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
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
        expect(renderer.root.findByProps({ testID: 'session-config-agent-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-worktree-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-permission-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-model-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-effort-trigger' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'session-config-fast-toggle' })).toBeDefined();
        expect(mocks.listWorktrees).not.toHaveBeenCalled();

        await act(async () => {
            renderer.root.findByProps({ testID: 'session-config-worktree-trigger' }).props.onPress();
            await Promise.resolve();
        });
        expect(mocks.listWorktrees).toHaveBeenCalledOnce();
        act(() => renderer.root.findByProps({ accessibilityLabel: 'new worktree' }).props.onPress());
        expect(mocks.setWorktreeKey).toHaveBeenLastCalledWith('__new__');
        act(() => vi.runOnlyPendingTimers());
        mocks.pickerCloseFocus.mockClear();

        act(() => renderer.root.findByProps({ testID: 'session-config-model-trigger' }).props.onPress());
        act(() => vi.runOnlyPendingTimers());
        expect(mocks.pickerCloseFocus).toHaveBeenCalledOnce();
        expect(renderer.root.findByProps({ testID: 'session-config-picker-model' }).props.accessibilityViewIsModal).toBe(true);
        act(() => renderer.root.findByProps({ testID: 'session-config-picker-close' }).props.onPress());
        expect(mocks.modelTriggerFocus).toHaveBeenCalledOnce();

        act(() => renderer.root.findByProps({ testID: 'session-config-model-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ accessibilityLabel: 'gpt-5.6-terra' }).props.onPress());
        expect(mocks.setModelMode).toHaveBeenCalledWith('gpt-5.6-terra');

        act(() => renderer.root.findByProps({ testID: 'session-config-permission-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ accessibilityLabel: 'agentInput.codexPermissionMode.readOnly' }).props.onPress());
        expect(mocks.setPermissionMode).toHaveBeenCalledWith('read-only');

        act(() => renderer.root.findByProps({ testID: 'session-config-fast-toggle' }).props.onPress());
        expect(ref.current.getSelection().fastMode).toBe(true);
    });

    it('clears a selected worktree when its machine or project scope changes', async () => {
        mocks.listWorktrees.mockResolvedValue([{ path: '/Users/test/happy--old', branch: 'old-branch' }]);
        const ref = React.createRef<any>();
        await act(async () => {
            renderer = TestRenderer.create(
                <SessionConfigPanel ref={ref} layout="composer" collapsible={false} />,
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
