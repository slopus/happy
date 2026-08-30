import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    updateEffort: vi.fn(),
    updateModel: vi.fn(),
    updatePermission: vi.fn(),
}));

vi.mock('react-native', () => ({
    LayoutAnimation: {
        configureNext: vi.fn(),
        Presets: { easeInEaseOut: {} },
    },
    Platform: {
        OS: 'web',
        select: (options: Record<string, unknown>) => options.web ?? options.default,
    },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            updateSessionEffortLevel: mocks.updateEffort,
            updateSessionModelMode: mocks.updateModel,
            updateSessionPermissionMode: mocks.updatePermission,
        }),
    },
    useSetting: () => null,
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/utils/newSessionExperience', () => ({
    getRunningSessionInfoExperience: () => ({
        showModelDetails: true,
        showPath: true,
        showPermission: true,
    }),
}));
vi.mock('@/utils/runningSessionTurnModes', () => ({
    resolveRunningSessionTurnModes: (args: { session: { effortLevel?: string; modelMode?: string } }) => ({
        availableEffortLevels: [
            { key: 'high', name: 'high' },
            { key: 'xhigh', name: 'xhigh' },
        ],
        availableModels: [
            { key: 'gpt-5.5', name: 'gpt-5.5' },
            { key: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
        ],
        effortLevel: { key: args.session.effortLevel ?? 'xhigh', name: args.session.effortLevel ?? 'xhigh' },
        modelMode: { key: args.session.modelMode ?? 'gpt-5.6-sol', name: args.session.modelMode ?? 'gpt-5.6-sol' },
    }),
}));
vi.mock('@/hooks/useSessionTaskPermission', () => ({
    useSessionTaskPermission: (_session: unknown, online: boolean) => ({
        level: 'confirm',
        onLevelChange: vi.fn().mockResolvedValue(true),
        online,
        supported: true,
        unavailableReason: online ? null : 'Machine offline',
    }),
}));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'agentInput.agent.claude': 'Claude',
        'agentInput.agent.codex': 'Codex',
        'agentInput.agent.gemini': 'Gemini',
        'agentInput.agent.opencode': 'OpenCode',
        'agentInput.agent.openclaw': 'OpenClaw',
        'agentInput.noMachinesAvailable': 'No machines',
        'agentInput.taskPermission.changesNextMessages': 'Applies to later messages.',
        'agentInput.taskPermission.confirm': 'Needs confirmation',
        'agentInput.taskPermission.fullAccess': 'Full access',
        'agentInput.taskPermission.unavailable': 'Unavailable',
        'sessionInfo.agentPanelAddress': 'Address',
        'sessionInfo.agentPanelAgent': 'Agent',
        'sessionInfo.agentPanelCurrentExecution': 'This execution',
        'sessionInfo.agentPanelEditable': 'Editable',
        'sessionInfo.agentPanelEffort': 'Reasoning effort',
        'sessionInfo.agentPanelMachineStatus': 'Machine status',
        'sessionInfo.agentPanelModel': 'Model',
        'sessionInfo.agentPanelOfflineNotice': 'This machine is offline. Settings are kept, but execution is unavailable.',
        'sessionInfo.agentPanelPermissions': 'Permissions',
        'sessionInfo.agentPanelReadOnly': 'Read-only',
        'sessionInfo.agentPanelRuntimeLocation': 'Runtime location',
        'sessionInfo.agentPanelSessionManagement': 'Session management',
        'sessionInfo.agentPanelWorkingDirectory': 'Working directory',
        'sessionInfo.happySessionId': 'Paws Session ID',
        'sessionInfo.happySessionIdCopied': 'Paws Session ID copied',
        'sessionInfo.viewDetails': 'Session details',
        'settingsAccount.notAvailable': 'Not available',
        'status.offline': 'offline',
        'status.online': 'online',
    } as Record<string, string>)[key] ?? key,
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            accent: '#08f',
            divider: '#444',
            input: { background: '#111' },
            shadow: { color: '#000', opacity: 0.2 },
            status: { connected: '#0f0', disconnected: '#888' },
            surface: '#181818',
            surfaceHigh: '#222',
            text: '#fff',
            textSecondary: '#aaa',
            warning: '#f90',
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

import { resolveSessionInfoAgentLabel, SessionInfoDropdown } from './SessionInfoDropdown';

const session = {
    id: 'session-1',
    effortLevel: 'xhigh',
    modelMode: 'gpt-5.6-sol',
    metadata: {
        flavor: 'codex',
        homeDir: '/Users/jacky',
        host: 'atlas-mac-mini.local',
        path: '/Users/jacky/work/atlas-dashboard',
    },
} as any;

function renderPanel(online: boolean, sharingEnabled = true) {
    const onShareSession = vi.fn();
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(
            <SessionInfoDropdown
                session={session}
                machineName="Atlas Mac mini"
                online={online}
                top={64}
                onClose={vi.fn()}
                onShareSession={sharingEnabled ? onShareSession : undefined}
                onViewDetails={vi.fn()}
            />,
        );
    });
    return { renderer, onShareSession };
}

describe('SessionInfoDropdown', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('preserves Ask and third-party flavor identity instead of relabeling them as Claude', () => {
        const translate = (key: string) => key === 'agentInput.agent.claude' ? 'Claude' : key;

        expect(resolveSessionInfoAgentLabel('ask', translate)).toBe('ask');
        expect(resolveSessionInfoAgentLabel('custom-acp-agent', translate)).toBe('custom-acp-agent');
        expect(resolveSessionInfoAgentLabel(undefined, translate)).toBe('Claude');
    });

    it('groups runtime, execution, and management while exposing honest row affordances', () => {
        const { renderer } = renderPanel(true);

        expect(renderer.root.findAllByProps({ testID: 'session-agent-panel-runtime-location' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'session-agent-panel-current-execution' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'session-agent-panel-session-management' })).toHaveLength(1);

        const address = renderer.root.findByProps({ testID: 'session-agent-panel-address' });
        expect(address.props.accessibilityRole).toBeUndefined();
        expect(address.props.accessibilityLabel).toContain('atlas-mac-mini.local');
        expect(address.props.accessibilityLabel).toContain('Read-only');
        expect(renderer.root.findByProps({ testID: 'session-agent-panel-agent' }).props.accessibilityRole).toBeUndefined();

        for (const testID of [
            'session-agent-panel-model',
            'session-agent-panel-effort',
            'session-agent-panel-permission',
        ]) {
            expect(renderer.root.findByProps({ testID }).props.accessibilityRole).toBe('button');
        }

        act(() => renderer.root.findByProps({ testID: 'session-agent-panel-model' }).props.onPress());
        const modelOptions = renderer.root.findByProps({ accessibilityRole: 'radiogroup' });
        expect(modelOptions.props.accessibilityLabel).toBe('Model');
        const alternateModel = renderer.root.findByProps({ testID: 'session-agent-panel-model-option-gpt-5.5' });
        expect(alternateModel.props.accessibilityRole).toBe('radio');
        expect(alternateModel.props.accessibilityState).toEqual({ checked: false });
        act(() => alternateModel.props.onPress());
        expect(mocks.updateModel).toHaveBeenCalledWith('session-1', 'gpt-5.5');

        act(() => renderer.unmount());
    });

    it('keeps the last execution values visible but removes edit affordances while offline', () => {
        const { renderer } = renderPanel(false);

        expect(renderer.root.findByProps({ testID: 'session-agent-panel-offline-notice' })).toBeTruthy();
        for (const testID of [
            'session-agent-panel-model',
            'session-agent-panel-effort',
            'session-agent-panel-permission',
        ]) {
            const row = renderer.root.findByProps({ testID });
            expect(row.props.accessibilityRole).toBeUndefined();
            expect(row.props.accessibilityLabel).toContain('Read-only');
        }
        expect(renderer.root.findByProps({ testID: 'session-agent-panel-model' }).props.accessibilityLabel)
            .toContain('gpt-5.6-sol');
        expect(renderer.root.findByProps({ testID: 'session-agent-panel-effort' }).props.accessibilityLabel)
            .toContain('xhigh');
        expect(renderer.root.findByProps({ testID: 'session-agent-panel-permission' }).props.accessibilityLabel)
            .toContain('Needs confirmation');

        act(() => renderer.unmount());
    });

    it('offers public sharing from the PC session-management section', () => {
        const { renderer, onShareSession } = renderPanel(true);

        const share = renderer.root.findByProps({ testID: 'session-agent-panel-share-session' });
        expect(share.props.accessibilityRole).toBe('button');
        act(() => share.props.onPress());
        expect(onShareSession).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });

    it('does not expose sharing when the responsive parent disables PC management', () => {
        const { renderer } = renderPanel(true, false);
        expect(renderer.root.findAllByProps({ testID: 'session-agent-panel-share-session' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
