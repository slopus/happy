import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    addSavedAccount: vi.fn(),
    auth: { switchAccount: vi.fn() },
    getActiveAccountKey: vi.fn(),
    getServerUrl: vi.fn(),
    listSavedAccounts: vi.fn(),
    params: {} as Record<string, string>,
    removeSavedAccount: vi.fn(),
    routerPush: vi.fn(),
}));

vi.mock('react-native', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('expo-router', () => ({
    router: { push: mocks.routerPush },
    useLocalSearchParams: () => mocks.params,
}));
vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    const animation = { duration: () => ({ reduceMotion: () => undefined }) };
    return {
        default: {
            View: (props: Record<string, unknown>) => ReactModule.createElement('AnimatedView', props, props.children as React.ReactNode),
        },
        FadeIn: animation,
        FadeOut: animation,
        LinearTransition: animation,
        ReduceMotion: { System: 'system' },
    };
});
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: (theme: unknown) => object) => factory({ colors: {
            divider: '#333',
            groupped: { background: '#111', sectionTitle: '#888' },
            input: { background: '#222', text: '#fff' },
            shadow: { color: '#000', opacity: 0.1 },
            surface: '#222',
            surfaceSelected: '#333',
            text: '#fff',
            textSecondary: '#aaa',
        } }),
    },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#aaa' } } }),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/auth/accounts', () => ({
    addSavedAccount: mocks.addSavedAccount,
    listSavedAccounts: mocks.listSavedAccounts,
    removeSavedAccount: mocks.removeSavedAccount,
}));
vi.mock('@/auth/accountRuntime', () => ({
    canonicalAccountServer: (value: string) => value,
    getActiveAccountKey: mocks.getActiveAccountKey,
}));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: mocks.getServerUrl }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/SecureTextInput', async () => {
    const ReactModule = await import('react');
    return {
        SecureTextInput: (props: Record<string, unknown>) => ReactModule.createElement('SecureTextInput', props),
    };
});
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'accounts.add': 'accounts.add',
        'accounts.label': 'accounts.label',
        'accounts.secret': 'accounts.secret',
        'accounts.server': 'accounts.server',
        'accounts.title': 'accounts.title',
        'common.cancel': 'common.cancel',
        'settingsAccount.tapToHide': 'settingsAccount.tapToHide',
        'settingsAccount.tapToReveal': 'settingsAccount.tapToReveal',
    }[key] ?? key),
}));
vi.mock('@/auth/accountLink', () => ({ parseAccountSessionTarget: () => undefined }));
vi.mock('@/auth/tokenStorage', () => ({ AccountVault: { read: vi.fn() } }));
vi.mock('@/auth/secretKeyBackup', () => ({ formatSecretKeyForBackup: (value: string) => value }));

import AccountsPage from '@/app/(app)/accounts';

describe('账号添加表单', () => {
    let renderer: any;

    const findItem = (title: string) => renderer.root.findAllByType('Item').find((item: any) => item.props.title === title);

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.params = {};
        mocks.getServerUrl.mockReturnValue('https://app.paws.rodeo');
        mocks.getActiveAccountKey.mockReturnValue('current-account');
        mocks.listSavedAccounts.mockResolvedValue([]);
        mocks.addSavedAccount.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        await act(async () => {
            renderer = TestRenderer.create(<AccountsPage />);
        });
    });

    it('每次重新打开时清空上一次输入，并关闭浏览器自动填充', () => {
        act(() => findItem('accounts.add').props.onPress());

        let inputs = renderer.root.findAllByType('TextInput');
        const serverInput = inputs.find((input: any) => input.props.accessibilityLabel === 'accounts.server');
        const labelInput = inputs.find((input: any) => input.props.accessibilityLabel === 'accounts.label');
        const secretInput = renderer.root.findByType('SecureTextInput');
        expect(serverInput.props.autoComplete).toBe('off');
        expect(labelInput.props.autoComplete).toBe('off');
        expect(secretInput.props.autoComplete).toBe('new-password');

        act(() => serverInput.props.onChangeText('https://stale.example'));
        act(() => labelInput.props.onChangeText('视频采集'));
        act(() => secretInput.props.onChangeText('secret-from-previous-account'));
        act(() => findItem('common.cancel').props.onPress());
        act(() => findItem('accounts.add').props.onPress());

        inputs = renderer.root.findAllByType('TextInput');
        expect(inputs.find((input: any) => input.props.accessibilityLabel === 'accounts.server').props.value).toBe('https://app.paws.rodeo');
        expect(inputs.find((input: any) => input.props.accessibilityLabel === 'accounts.label').props.value).toBe('');
        expect(renderer.root.findByType('SecureTextInput').props.value).toBe('');
    });

    it('密钥输入交给带显示/隐藏按钮的安全输入组件', () => {
        act(() => findItem('accounts.add').props.onPress());

        expect(renderer.root.findByType('SecureTextInput').props.visibilityButtonTestID)
            .toBe('accounts-secret-visibility-toggle');
        expect(renderer.root.findByType('SecureTextInput').props.showValueAccessibilityLabel)
            .toBe('settingsAccount.tapToReveal');
        expect(renderer.root.findByType('SecureTextInput').props.hideValueAccessibilityLabel)
            .toBe('settingsAccount.tapToHide');
    });
});
