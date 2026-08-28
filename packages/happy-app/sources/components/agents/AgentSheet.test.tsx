import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLauncher } from './launchAgent';
import type { Machine } from '@/sync/storageTypes';
import { AgentSheet } from './AgentSheet';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    agents: [] as AgentLauncher[],
    machines: [] as Machine[],
    entering: false,
    enter: vi.fn(),
    oldEnterSpace: vi.fn(),
    launchAgent: vi.fn(),
    routerNavigate: vi.fn(),
    builtinAgent: null as AgentLauncher | null,
    relationshipAgent: null as AgentLauncher | null,
    relationshipPluginStatus: { installed: true } as { installed: boolean } | null,
    platform: 'web',
    windowWidth: 1280,
}));

vi.mock('react-native', () => ({
    Text: 'Text',
    View: 'View',
    Pressable: 'Pressable',
    Modal: 'Modal',
    ScrollView: 'ScrollView',
    Platform: { get OS() { return mocks.platform; } },
    useWindowDimensions: () => ({ width: mocks.windowWidth, height: 800, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate: mocks.routerNavigate }),
}));
vi.mock('react-native-unistyles', () => {
    const mockTheme = {
        colors: {
            groupped: { background: '#fff' }, divider: '#ddd', text: '#111', textSecondary: '#666',
            surfacePressed: '#eee', surface: '#fff', status: { connected: '#0a0', disconnected: '#a00' },
            shadow: { color: '#000', opacity: 0.2 },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof mockTheme) => object)(mockTheme)
                : factory,
        },
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => mocks.agents,
    useAllMachines: () => mocks.machines,
}));
vi.mock('@/hooks/useNewSessionDraft', () => ({ useNewSessionDraft: () => ({}) }));
vi.mock('@/hooks/useAgentSpace', () => ({ useAgentSpace: () => ({ enter: mocks.oldEnterSpace }) }));
vi.mock('@/hooks/useEnterAgentSpace', () => ({
    useEnterAgentSpace: () => ({ entering: mocks.entering, enter: mocks.enter }),
}));
vi.mock('@/hooks/useRelationshipAdvisorPlugin', () => ({
    useRelationshipAdvisorPlugin: () => ({
        loading: false,
        status: mocks.relationshipPluginStatus,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./launchAgent', async () => {
    const actual = await vi.importActual<typeof import('./launchAgent')>('./launchAgent');
    return { ...actual, launchAgent: mocks.launchAgent };
});
vi.mock('./builtinAgents', () => ({
    createAppBuilderAgent: () => mocks.builtinAgent,
    createRelationshipAdvisorAgent: () => mocks.relationshipAgent,
    getAgentSubtitle: (agent: AgentLauncher) => agent.path,
}));

const agent: AgentLauncher = {
    id: 'agent-1',
    name: 'Persisted Agent',
    glyph: 'A',
    color: '#5e5791',
    machineId: 'machine-1',
    path: '~/work',
    kind: 'standard',
    spaceType: 'default',
    imageStyleIds: [],
    imageVariantsPerStyle: 1,
    presets: [],
};

const cloudRelationshipAgent: AgentLauncher = {
    ...agent,
    id: 'builtin:relationship-advisor',
    name: '狗头军师',
    machineId: '',
    path: '云端极速对话',
    runtime: 'relationship-advisor',
    builtin: true,
};

const machine: Machine = {
    id: 'machine-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: { host: 'mac', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp', homeDir: '/Users/jacky' },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 1,
};

function textValue(node: { props: { children?: unknown } }): string {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
}

function findPressableByText(root: any, label: string) {
    return root.findAllByType('Pressable').find((node: any) => (
        node.findAllByType('Text').some((text: any) => textValue(text) === label)
    ));
}

describe('AgentSheet', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.agents = [agent];
        mocks.machines = [machine];
        mocks.entering = false;
        mocks.builtinAgent = null;
        mocks.relationshipAgent = cloudRelationshipAgent;
        mocks.relationshipPluginStatus = { installed: true };
        mocks.platform = 'web';
        mocks.windowWidth = 1280;
        mocks.enter.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('keeps the sheet open until the persisted Agent coordinator invokes beforeNavigate', async () => {
        const onClose = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={onClose} />);
        });
        const row = findPressableByText(renderer.root, agent.name);

        await act(async () => {
            await row.props.onPress();
        });

        expect(mocks.enter).toHaveBeenCalledTimes(1);
        expect(mocks.enter.mock.calls[0][0]).toBe(agent);
        expect(onClose).not.toHaveBeenCalled();

        act(() => mocks.enter.mock.calls[0][1].beforeNavigate());
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('uses a compact fading dialog on desktop web', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={vi.fn()} />);
        });

        expect(renderer.root.findByType('Modal').props.animationType).toBe('fade');
        const dialog = renderer.root.findByProps({ testID: 'agent-sheet-desktop-dialog' });
        expect(dialog.props.style).toContainEqual(expect.objectContaining({
            maxWidth: 520,
            borderRadius: 12,
            backgroundColor: '#fff',
        }));
        expect(renderer.root.findAllByProps({ testID: 'agent-sheet-mobile-drawer' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps the sliding bottom drawer on narrow screens', () => {
        mocks.windowWidth = 430;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={vi.fn()} />);
        });

        expect(renderer.root.findByType('Modal').props.animationType).toBe('slide');
        expect(renderer.root.findAllByProps({ testID: 'agent-sheet-mobile-drawer' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'agent-sheet-desktop-dialog' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('disables persisted Agent actions while entry is in progress', () => {
        mocks.entering = true;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={vi.fn()} />);
        });

        expect(findPressableByText(renderer.root, agent.name).props.disabled).toBe(true);
        act(() => renderer.unmount());
    });

    it('retains direct /new launch behavior for the built-in Agent', async () => {
        const builtinAgent: AgentLauncher = {
            ...agent,
            id: 'builtin:app-builder',
            name: 'Built-in Agent',
            builtin: true,
            agentType: 'claude',
        };
        mocks.builtinAgent = builtinAgent;
        const onClose = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={onClose} />);
        });

        await act(async () => {
            await findPressableByText(renderer.root, builtinAgent.name).props.onPress();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.launchAgent).toHaveBeenCalledTimes(1);
        expect(mocks.launchAgent.mock.calls[0][0]).toBe(builtinAgent);
        expect(mocks.enter).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps the cloud relationship advisor available without a machine', async () => {
        mocks.agents = [];
        mocks.machines = [];
        mocks.relationshipAgent = cloudRelationshipAgent;
        const onClose = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={onClose} />);
        });

        const row = findPressableByText(renderer.root, cloudRelationshipAgent.name);
        expect(row.props.disabled).toBe(false);
        await act(async () => row.props.onPress());

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.launchAgent).toHaveBeenCalledWith(cloudRelationshipAgent, expect.anything(), expect.any(Function));
        act(() => renderer.unmount());
    });

    it('hides an uninstalled relationship advisor from My Agents', () => {
        mocks.agents = [];
        mocks.machines = [];
        mocks.relationshipPluginStatus = { installed: false };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={vi.fn()} />);
        });

        expect(findPressableByText(renderer.root, cloudRelationshipAgent.name)).toBeUndefined();
        expect(mocks.launchAgent).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps persisted image-style Agents on enterSpace without spawning', async () => {
        const imageAgent: AgentLauncher = {
            ...agent,
            id: 'image-agent',
            name: 'Image Agent',
            kind: 'image-styles',
            imageStyleIds: ['style-1'],
        };
        mocks.agents = [imageAgent];
        const onClose = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentSheet visible onClose={onClose} />);
        });

        await act(async () => {
            await findPressableByText(renderer.root, imageAgent.name).props.onPress();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.oldEnterSpace).toHaveBeenCalledWith(imageAgent.id);
        expect(mocks.enter).not.toHaveBeenCalled();
        expect(mocks.launchAgent).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
