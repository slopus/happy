import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestoreManual from '@/app/(app)/restore/manual';
import { createServiceAuthorizationLogin, serviceAuthorizationLoginParams, serviceAuthorizationReturnPath } from '@/auth/serviceAuthorizationLogin';

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
    params: {} as Record<string, unknown>,
    focused: true,
}));

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: mocks.replace }),
    useLocalSearchParams: () => mocks.params,
    useFocusEffect: (callback: () => void) => React.useEffect(() => mocks.focused ? callback() : undefined, [callback, mocks.focused]),
}));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: mocks.isAuthenticated,
        login: mocks.login,
    }),
}));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({ fontFamily: 'MapleMonoNL-Regular' }),
    },
}));
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
        mocks.params = {};
        mocks.focused = true;
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

    it.each([false, true])('returns service login to the same authorization, including an authenticated revisit (%s)', async authenticated => {
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        mocks.params = serviceAuthorizationLoginParams(intent);
        mocks.isAuthenticated = authenticated;
        act(() => renderer.update(<RestoreManual />));
        if (!authenticated) {
            act(() => renderer.root.findByType('TextInput').props.onChangeText('formatted-key'));
            const button = renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === 'connect.restoreAccount');
            await act(async () => { await button.props.action(); });
            expect(mocks.login).toHaveBeenCalledWith('token', 'normalized-key', { serviceAuthorization: intent, signal: expect.any(AbortSignal) });
        }
        expect(mocks.replace).toHaveBeenCalledWith(serviceAuthorizationReturnPath(intent));
        expect(mocks.replace).not.toHaveBeenCalledWith('/');
    });

    it('cancels an unfinished service login without logging in when its token arrives', async () => {
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        mocks.params = serviceAuthorizationLoginParams(intent);
        let finish!: (token: string) => void;
        mocks.authGetToken.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
        act(() => renderer.update(<RestoreManual />));
        act(() => renderer.root.findByType('TextInput').props.onChangeText('formatted-key'));
        let pending!: Promise<void>;
        await act(async () => { pending = renderer.root.findAllByType('RoundButton').find((node: any) => node.props.action).props.action(); });
        act(() => renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === '取消登录').props.onPress());
        await act(async () => { finish('late-token'); await pending; });
        expect(mocks.login).not.toHaveBeenCalled();
        expect(mocks.replace).toHaveBeenCalledWith(serviceAuthorizationReturnPath(intent));
    });

    it('does not follow an external returnTo parameter', async () => {
        mocks.params = { returnTo: 'https://evil.example' };
        mocks.isAuthenticated = true;
        act(() => renderer.update(<RestoreManual />));
        expect(mocks.replace).toHaveBeenCalledWith('/');
        expect(mocks.replace).not.toHaveBeenCalledWith('https://evil.example');
    });

    it.each(['replaced', 'blurred'])('ignores an old token result after the authorization request is %s', async change => {
        const first = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        const next = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000002')!;
        mocks.params = serviceAuthorizationLoginParams(first);
        let finish!: (token: string) => void;
        mocks.authGetToken.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
        act(() => renderer.update(<RestoreManual />));
        act(() => renderer.root.findByType('TextInput').props.onChangeText('formatted-key'));
        let pending!: Promise<void>;
        await act(async () => { pending = renderer.root.findAllByType('RoundButton').find((node: any) => node.props.action).props.action(); });
        if (change === 'replaced') mocks.params = serviceAuthorizationLoginParams(next);
        else mocks.focused = false;
        act(() => renderer.update(<RestoreManual />));
        await act(async () => { finish('old-token'); await pending; });
        expect(mocks.login).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
    });
});
