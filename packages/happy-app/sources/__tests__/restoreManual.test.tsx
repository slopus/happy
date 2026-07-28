import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestoreManual from '@/app/(app)/restore/manual';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    authGetToken: vi.fn(),
    decodeBase64: vi.fn(),
    isAuthenticated: false,
    login: vi.fn(),
    normalizeSecretKey: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: mocks.isAuthenticated,
        login: mocks.login,
    }),
}));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/auth/secretKeyBackup', () => ({
    normalizeSecretKey: mocks.normalizeSecretKey,
}));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: mocks.authGetToken }));
vi.mock('@/encryption/base64', () => ({ decodeBase64: mocks.decodeBase64 }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: unknown) => object) => factory({
            colors: {
                input: {
                    background: '#111111',
                    placeholder: '#777777',
                    text: '#ffffff',
                },
                surface: '#000000',
                textSecondary: '#aaaaaa',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: {
                    placeholder: '#777777',
                },
            },
        },
    }),
}));

describe('密钥恢复页', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isAuthenticated = false;
        mocks.normalizeSecretKey.mockReturnValue('normalized-key');
        mocks.decodeBase64.mockReturnValue(new Uint8Array(32));
        mocks.authGetToken.mockResolvedValue('token');
        mocks.login.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        act(() => {
            renderer = TestRenderer.create(<RestoreManual />);
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        consoleErrorSpy.mockRestore();
    });

    it('使用密码输入语义，成功后替换为首页而不是退回上一层恢复页', async () => {
        const input = renderer.root.findByType('TextInput');
        expect(input.props.secureTextEntry).toBe(true);
        expect(input.props.accessibilityLabel).toBe('settingsAccount.secretKey');

        act(() => input.props.onChangeText(' formatted-key '));
        const button = renderer.root.findByType('RoundButton');
        await act(async () => {
            await button.props.action();
        });

        expect(mocks.normalizeSecretKey).toHaveBeenCalledWith('formatted-key');
        expect(mocks.login).toHaveBeenCalledWith('token', 'normalized-key');
        expect(mocks.replace).toHaveBeenCalledWith('/');
    });

    it('同一次恢复未结束时忽略重复提交', async () => {
        let finishLogin!: () => void;
        mocks.login.mockImplementation(() => new Promise<void>((resolve) => {
            finishLogin = resolve;
        }));

        const input = renderer.root.findByType('TextInput');
        act(() => input.props.onChangeText('formatted-key'));
        const action = renderer.root.findByType('RoundButton').props.action;

        let firstRequest!: Promise<void>;
        await act(async () => {
            firstRequest = action();
            await action();
        });

        expect(mocks.authGetToken).toHaveBeenCalledTimes(1);
        expect(mocks.login).toHaveBeenCalledTimes(1);

        await act(async () => {
            finishLogin();
            await firstRequest;
        });
        expect(mocks.replace).toHaveBeenCalledTimes(1);
    });

    it('已登录时直接收口到首页', () => {
        act(() => renderer.unmount());
        mocks.isAuthenticated = true;

        act(() => {
            renderer = TestRenderer.create(<RestoreManual />);
        });

        expect(mocks.replace).toHaveBeenCalledWith('/');
    });
});
