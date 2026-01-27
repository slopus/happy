import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const requests: unknown[] = [];

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => {
    return {
        Platform: { OS: 'web', select: (o: any) => o.web ?? o.default },
        TurboModuleRegistry: { getEnforcing: () => ({}) },
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        RefreshControl: 'RefreshControl',
        Pressable: 'Pressable',
        TextInput: 'TextInput',
    };
});

vi.mock('@expo/vector-icons', () => {
    return {
        Ionicons: 'Ionicons',
        Octicons: 'Octicons',
    };
});

vi.mock('expo-router', () => {
    const Stack: any = {};
    Stack.Screen = () => null;
    return {
        Stack,
        useLocalSearchParams: () => ({ id: 'machine-1' }),
        useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    };
});

vi.mock('react-native-unistyles', () => {
    const React = require('react');
    return {
        useUnistyles: () => {
            React.useMemo(() => 0, []);
            return {
                theme: {
                    colors: {
                        header: { tint: '#000' },
                        input: { background: '#fff', text: '#000' },
                        groupped: { background: '#fff', sectionTitle: '#000' },
                        divider: '#ddd',
                        button: { primary: { background: '#000', tint: '#fff' } },
                        text: '#000',
                        textSecondary: '#666',
                        surface: '#fff',
                        surfaceHigh: '#fff',
                        shadow: { color: '#000', opacity: 0.1 },
                        status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' },
                        permissionButton: { inactive: { background: '#ccc' } },
                    },
                },
            };
        },
        StyleSheet: {
            create: (fn: any) => fn({
                colors: {
                    header: { tint: '#000' },
                    input: { background: '#fff', text: '#000' },
                    groupped: { background: '#fff', sectionTitle: '#000' },
                    divider: '#ddd',
                    button: { primary: { background: '#000', tint: '#fff' } },
                    text: '#000',
                    textSecondary: '#666',
                    surface: '#fff',
                    surfaceHigh: '#fff',
                    shadow: { color: '#000', opacity: 0.1 },
                    status: { error: '#f00' },
                    permissionButton: { inactive: { background: '#ccc' } },
                },
            }),
        },
    };
});

vi.mock('@/constants/Typography', () => {
    return { Typography: { default: () => ({}) } };
});

vi.mock('@/text', () => {
    return { t: (key: string) => key };
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/MultiTextInput', () => ({
    MultiTextInput: () => null,
}));

vi.mock('@/components/machines/DetectedClisList', () => ({
    DetectedClisList: () => null,
}));

vi.mock('@/components/Switch', () => ({
    Switch: () => null,
}));

vi.mock('@/modal', () => {
    return { Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } };
});

vi.mock('@/sync/storage', () => {
    const React = require('react');
    return {
        storage: { getState: () => ({ applyFriends: vi.fn() }) },
        useSessions: () => [],
        useAllMachines: () => [],
        useMachine: () => null,
        useSettings: () => {
            React.useMemo(() => 0, []);
            return {
                experiments: true,
                expCodexResume: true,
                expCodexAcp: false,
            };
        },
        useSetting: (name: string) => {
            React.useMemo(() => 0, [name]);
            if (name === 'experiments') return true;
            if (name === 'expCodexResume') return true;
            return false;
        },
        useSettingMutable: (name: string) => {
            React.useMemo(() => 0, [name]);
            return [name === 'codexResumeInstallSpec' ? '' : null, vi.fn()];
        },
    };
});

vi.mock('@/hooks/useNavigateToSession', () => {
    return { useNavigateToSession: () => () => {} };
});

vi.mock('@/hooks/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (params: any) => {
            requests.push(params.request);
            return { state: { status: 'idle' }, refresh: vi.fn() };
        },
    };
});

vi.mock('@/sync/ops', () => {
    return {
        machineCapabilitiesInvoke: vi.fn(),
        machineSpawnNewSession: vi.fn(),
        machineStopDaemon: vi.fn(),
        machineUpdateMetadata: vi.fn(),
    };
});

vi.mock('@/sync/sync', () => {
    return { sync: { refreshMachines: vi.fn(), retryNow: vi.fn() } };
});

vi.mock('@/utils/machineUtils', () => {
    return { isMachineOnline: () => true };
});

vi.mock('@/utils/sessionUtils', () => {
    return {
        formatPathRelativeToHome: () => '',
        getSessionName: () => '',
        getSessionSubtitle: () => '',
    };
});

vi.mock('@/utils/pathUtils', () => {
    return { resolveAbsolutePath: () => '' };
});

vi.mock('@/sync/terminalSettings', () => {
    return { resolveTerminalSpawnOptions: () => ({}) };
});

describe('MachineDetailScreen capabilities request', () => {
    it('passes a stable request object to useMachineCapabilitiesCache', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(React.createElement(MachineDetailScreen));
        });

        act(() => {
            tree!.update(React.createElement(MachineDetailScreen));
        });

        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests[0]).toBe(requests[1]);
    });
});
