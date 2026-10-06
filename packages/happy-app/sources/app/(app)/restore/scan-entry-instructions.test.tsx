import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    authQRStart: vi.fn(() => new Promise<boolean>(() => {})),
    replace: vi.fn(),
    params: {} as Record<string, unknown>,
    push: vi.fn(), login: vi.fn(), authQRWait: vi.fn(), isAuthenticated: false,
    focused: true,
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock('expo-router', () => {
    const router = { push: mocks.push, replace: mocks.replace };
    return { useRouter: () => router, useLocalSearchParams: () => mocks.params,
        useFocusEffect: (callback: () => void) => React.useEffect(() => mocks.focused ? callback() : undefined, [callback, mocks.focused]) };
});
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: mocks.isAuthenticated, login: mocks.login }),
}));
vi.mock('@/auth/authQRStart', () => ({
    authQRStart: mocks.authQRStart,
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
}));
vi.mock('@/auth/authQRWait', () => ({ authQRWait: mocks.authQRWait }));
vi.mock('@/components/qr/QRCode', () => ({ QRCode: 'QRCode' }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: () => 'encoded-key' }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/restoreLayout', () => ({ getRestoreLayout: () => 'compact' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: {
                surface: '#000000',
                surfaceHigh: '#111111',
                text: '#ffffff',
                textSecondary: '#aaaaaa',
            },
        }),
    },
    useUnistyles: () => ({ theme: { colors: { text: '#ffffff' } } }),
}));

import RestoreDeviceScreen from './index';
import { createServiceAuthorizationLogin, serviceAuthorizationLoginParams, serviceAuthorizationReturnPath } from '@/auth/serviceAuthorizationLogin';

describe('Restore device scan instructions', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.params = {}; mocks.isAuthenticated = false;
        mocks.focused = true;
        mocks.authQRStart.mockImplementation(() => new Promise<boolean>(() => {}));
        mocks.authQRWait.mockReset(); mocks.login.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => {
            renderer = TestRenderer.create(<RestoreDeviceScreen />);
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        consoleErrorSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('points to the single scanner on the settings home instead of the removed account entry', () => {
        const instructions = renderer.root
            .findByProps({ testID: 'restore-device-instructions' })
            .findAllByType('Text')
            .flatMap((node: any) => node.props.children)
            .filter((value: unknown): value is string => typeof value === 'string')
            .join('');

        expect(instructions).toContain('2. Go to "settings.title"');
        expect(instructions).toContain('3. Tap "settings.scanQrCodeToAuthenticate"');
        expect(instructions).not.toContain('Settings → Account');
        expect(instructions).not.toContain('Link New Device');
    });

    it.each([false, true])('returns to service consent after QR login or an authenticated revisit (%s)', async authenticated => {
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        mocks.params = serviceAuthorizationLoginParams(intent); mocks.isAuthenticated = authenticated;
        mocks.authQRStart.mockResolvedValue(true);
        mocks.authQRWait.mockResolvedValue({ token: 'token', secret: new Uint8Array(32) });
        await act(async () => renderer.update(<RestoreDeviceScreen />));
        if (!authenticated) expect(mocks.login).toHaveBeenCalledWith('token', 'encoded-key', { serviceAuthorization: intent, signal: expect.any(AbortSignal) });
        else expect(mocks.login).not.toHaveBeenCalled();
        expect(mocks.replace).toHaveBeenCalledWith(serviceAuthorizationReturnPath(intent));
        expect(mocks.replace).not.toHaveBeenCalledWith('/');
    });

    it('keeps the same intent in the same-phone manual login and cancel routes', async () => {
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        mocks.params = serviceAuthorizationLoginParams(intent);
        await act(async () => renderer.update(<RestoreDeviceScreen />));
        act(() => renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === '使用账号密钥登录').props.onPress());
        expect(mocks.push).toHaveBeenCalledWith({ pathname: '/restore/manual', params: mocks.params });
        act(() => renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === '取消登录').props.onPress());
        expect(mocks.replace).toHaveBeenCalledWith(serviceAuthorizationReturnPath(intent));
    });

    it.each(['cancel', 'expired', 'replaced', 'blurred', 'manual'])('ignores a pending QR login after its intent is %s', async action => {
        const startedAt = Date.now();
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001', startedAt)!;
        mocks.params = serviceAuthorizationLoginParams(intent);
        let finish!: (value: unknown) => void;
        mocks.authQRStart.mockResolvedValue(true);
        mocks.authQRWait.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await act(async () => renderer.update(<RestoreDeviceScreen />));
        if (action === 'cancel') act(() => renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === '取消登录').props.onPress());
        else if (action === 'expired') vi.spyOn(Date, 'now').mockReturnValue(startedAt + 600_000);
        else if (action === 'manual') act(() => renderer.root.findAllByType('RoundButton').find((node: any) => node.props.title === '使用账号密钥登录').props.onPress());
        else if (action === 'blurred') { mocks.focused = false; await act(async () => renderer.update(<RestoreDeviceScreen />)); }
        else {
            mocks.authQRStart.mockImplementation(() => new Promise<boolean>(() => {}));
            mocks.params = serviceAuthorizationLoginParams(createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000002')!);
            await act(async () => renderer.update(<RestoreDeviceScreen />));
        }
        await act(async () => { finish({ token: 'old-token', secret: new Uint8Array(32) }); });
        expect(mocks.login).not.toHaveBeenCalled();
        if (action === 'expired') expect(JSON.stringify(renderer.toJSON())).toContain('授权链接已过期或无效');
        if (action === 'replaced') expect(mocks.replace).not.toHaveBeenCalled();
    });
});
