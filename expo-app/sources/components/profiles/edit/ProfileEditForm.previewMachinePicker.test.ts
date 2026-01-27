import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const routerPushMock = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (spec: any) => (spec && 'ios' in spec ? spec.ios : spec?.default) },
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    Linking: {},
    useWindowDimensions: () => ({ height: 800, width: 400 }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushMock }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
                button: { secondary: { tint: '#000' }, primary: { background: '#00f' } },
                surface: '#fff',
                text: '#000',
                status: { connected: '#0f0', disconnected: '#f00' },
                input: { placeholder: '#999' },
            },
        },
        rt: { themeName: 'light' },
    }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const modalShowMock = vi.fn();
vi.mock('@/modal', () => ({
    Modal: { show: (...args: any[]) => modalShowMock(...args), alert: vi.fn() },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: () => ({}),
    useAllMachines: () => [{ id: 'm1', metadata: { displayName: 'M1' } }],
    useMachine: () => null,
    useSettingMutable: (key: string) => {
        if (key === 'favoriteMachines') return [[], vi.fn()];
        if (key === 'secrets') return [[], vi.fn()];
        if (key === 'secretBindingsByProfileId') return [{}, vi.fn()];
        return [[], vi.fn()];
    },
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/hooks/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown' }),
}));

vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
    EnvironmentVariablesList: () => null,
}));

vi.mock('@/components/SessionTypeSelector', () => ({
    SessionTypeSelector: () => null,
}));

vi.mock('@/components/ui/forms/OptionTiles', () => ({
    OptionTiles: () => null,
}));

vi.mock('@/agents/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog', () => ({
    getAgentCore: () => ({ permissions: { modeGroup: 'default' } }),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

let capturedPreviewMachineItem: any = null;
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        if (props?.onPress && props?.title === 'profiles.previewMachine.itemTitle') {
            capturedPreviewMachineItem = props;
        }
        return null;
    },
}));

vi.mock('@/components/Switch', () => ({
    Switch: () => null,
}));

vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/sync/profileUtils', () => ({
    getBuiltInProfileDocumentation: () => null,
}));

vi.mock('@/sync/permissionTypes', () => ({
    normalizeProfileDefaultPermissionMode: (x: any) => x,
}));

vi.mock('@/sync/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => '',
    getPermissionModeOptionsForAgentType: () => [],
    normalizePermissionModeForAgentType: (x: any) => x,
}));

vi.mock('@/sync/permissionDefaults', () => ({
    inferSourceModeGroupForPermissionMode: () => 'default',
}));

vi.mock('@/sync/permissionMapping', () => ({
    mapPermissionModeAcrossAgents: (x: any) => x,
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/utils/profiles/envVarTemplate', () => ({
    parseEnvVarTemplate: () => ({ variables: [] }),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

describe('ProfileEditForm (native preview machine picker)', () => {
    it('opens a picker screen instead of a modal overlay on native', async () => {
        const { ProfileEditForm } = await import('@/components/profiles/edit');
        capturedPreviewMachineItem = null;
        routerPushMock.mockClear();
        modalShowMock.mockClear();

        await act(async () => {
            renderer.create(
                React.createElement(ProfileEditForm, {
                    profile: {
                        id: 'p1',
                        name: 'P',
                        environmentVariables: [],
                        defaultPermissionModeByAgent: {},
                        compatibility: { claude: true, codex: true, gemini: true },
                        envVarRequirements: [],
                        isBuiltIn: false,
                        createdAt: 0,
                        updatedAt: 0,
                        version: '1.0.0',
                    },
                    machineId: null,
                    onSave: () => true,
                    onCancel: vi.fn(),
                }),
            );
        });

        expect(capturedPreviewMachineItem).toBeTruthy();

        await act(async () => {
            capturedPreviewMachineItem.onPress();
        });

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(routerPushMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/new/pick/preview-machine',
            params: {},
        });
    });
});
