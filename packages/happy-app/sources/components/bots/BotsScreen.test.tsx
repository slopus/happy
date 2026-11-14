import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { BotsScreen } from './BotsScreen';

const mocks = vi.hoisted(() => ({ token: 'account-one', focused: true, fetch: vi.fn() }));
vi.mock('react-native', async () => {
    const R = await import('react');
    return { Platform: { OS: 'web', select: (values: any) => values.web ?? values.default }, View: 'View', ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => R.createElement('Pressable', props, typeof children === 'function' ? children({ pressed: false }) : children) };
});
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { StyleSheet: { hairlineWidth: 1, create: (fn: any) => fn(appThemes.ginghamDark) }, useUnistyles: () => ({ theme: appThemes.ginghamDark }) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused, DrawerActions: { openDrawer: vi.fn() } }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: vi.fn() }) }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => true }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: mocks.token } }) }));
vi.mock('@/sync/storage', () => ({ useSetting: () => 'zh-Hans' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://localhost:9001' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./BotsFrame', () => ({ BotsFrame: 'BotsFrame' }));

let tree: any;
const launch = () => ({ runtimeUrl: 'http://127.0.0.1:3490/', ticket: 't'.repeat(43), expiresAt: Date.now() + 60_000 });
const response = (value = launch()) => ({ ok: true, json: async () => value });
async function mount() { await act(async () => { tree = TestRenderer.create(<BotsScreen />); }); }

describe('Bots upstream handoff', () => {
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.token = 'account-one'; mocks.focused = true; mocks.fetch.mockReset();
        mocks.fetch.mockResolvedValue(response());
        vi.stubGlobal('fetch', mocks.fetch);
        vi.stubGlobal('window', { location: { origin: 'http://localhost:9000' } });
    });
    afterEach(async () => {
        if (tree) await act(async () => tree.unmount()); tree = null;
        vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it('authenticates the launch with Paws and hands only the one-use ticket to the upstream frame', async () => {
        await mount();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = mocks.fetch.mock.calls[0];
        expect(url).toBe('http://localhost:9001/v1/bots/launch');
        expect(options.headers.Authorization).toBe('Bearer account-one');
        expect(JSON.parse(options.body)).toEqual({ parentOrigin: 'http://localhost:9000', platform: 'web', locale: 'zh', appearance: 'dark' });
        const frame = tree.root.findByType('BotsFrame');
        expect(frame.props.ticket).toHaveLength(43);
        expect(JSON.stringify(frame.props)).not.toContain('account-one');
        await act(async () => frame.props.onAuthenticated());
        expect(tree.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('ignores a delayed response and aborts its request after leaving Bots', async () => {
        let resolve!: (value: unknown) => void;
        mocks.fetch.mockReturnValue(new Promise(value => { resolve = value; }));
        await mount(); const signal = mocks.fetch.mock.calls[0][1].signal;
        mocks.focused = false; await act(async () => tree.update(<BotsScreen />));
        expect(signal.aborted).toBe(true);
        await act(async () => resolve(response()));
        expect(tree.root.findAllByType('BotsFrame')).toHaveLength(0);
    });

    it('drops both the previous account frame and its late callbacks on an account switch', async () => {
        await mount(); const previous = tree.root.findByType('BotsFrame');
        const callback = previous.props.onAuthenticated;
        const failure = previous.props.onFailure;
        let resolve!: (value: unknown) => void;
        mocks.fetch.mockReturnValue(new Promise(value => { resolve = value; }));
        mocks.token = 'account-two'; await act(async () => tree.update(<BotsScreen />));
        expect(tree.root.findAllByType('BotsFrame')).toHaveLength(0);
        await act(async () => { callback(); failure(); });
        expect(tree.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
        await act(async () => resolve(response()));
        expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer account-two');
        expect(tree.root.findAllByType('BotsFrame')).toHaveLength(1);
    });

    it.each(['http://public.example/', 'https://bots.example/path/', 'https://bots.example/?token=bad', 'https://secret@bots.example/'])('rejects an unsafe or credential-bearing runtime URL: %s', async runtimeUrl => {
        mocks.fetch.mockResolvedValue(response({ ...launch(), runtimeUrl })); await mount();
        expect(tree.root.findAllByType('BotsFrame')).toHaveLength(0);
        expect(tree.root.findByProps({ accessibilityRole: 'alert' }).children).toContain('bots.unavailable');
    });

    it('offers an explicit retry without exposing a failed backend response', async () => {
        mocks.fetch.mockRejectedValueOnce(new Error('private operator diagnostic'));
        await mount();
        expect(JSON.stringify(tree.toJSON())).not.toContain('private operator');
        await act(async () => tree.root.findByProps({ testID: 'bots-retry' }).props.onPress());
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(tree.root.findAllByType('BotsFrame')).toHaveLength(1);
    });

    it('bounds an unresponsive launch request with one timeout and no repeated requests', async () => {
        vi.useFakeTimers(); mocks.fetch.mockReturnValue(new Promise(() => {})); await mount();
        const signal = mocks.fetch.mock.calls[0][1].signal;
        await act(async () => vi.advanceTimersByTime(45_001));
        expect(signal.aborted).toBe(true);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(1);
    });
});
