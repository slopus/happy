import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalScreen from '@/app/(app)/terminal';
import TerminalConnectScreen from '@/app/(app)/terminal/connect';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    back: vi.fn(),
    processAuthUrl: vi.fn(async () => {}),
    replace: vi.fn(),
    searchParams: {} as Record<string, string>,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => mocks.searchParams,
    useRouter: () => ({ back: mocks.back, replace: mocks.replace }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/hooks/useConnectTerminal', () => ({
    useConnectTerminal: () => ({
        isLoading: false,
        processAuthUrl: mocks.processAuthUrl,
    }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/InvalidRouteState', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#ff8a00',
                radio: { active: '#ff8a00' },
                success: '#00aa66',
                text: '#ffffff',
                textDestructive: '#ff0000',
                textSecondary: '#888888',
            },
        },
    }),
}));

describe('terminal invalid-link recovery', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    const originalWindow = globalThis.window;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.back.mockClear();
        mocks.processAuthUrl.mockClear();
        mocks.replace.mockClear();
        mocks.searchParams = {};
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                history: { replaceState: vi.fn() },
                location: { hash: '', pathname: '/terminal/connect', search: '' },
            },
        });
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: originalWindow,
        });
    });

    it.each([
        ['terminal query alias', TerminalScreen],
        ['terminal hash alias', TerminalConnectScreen],
    ])('offers the same deterministic Home recovery from the invalid %s', (_name, Screen) => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<Screen />);
        });

        const invalidState = renderer.root.findByType('InvalidRouteState');
        expect(invalidState.props).toMatchObject({
            actionLabel: 'common.home',
            description: 'terminal.invalidConnectionLinkDescription',
            title: 'terminal.invalidConnectionLink',
        });

        act(() => invalidState.props.onAction());
        expect(mocks.replace).toHaveBeenCalledWith('/');
        expect(mocks.back).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('preserves the existing confirmation flow for valid query and hash links', async () => {
        mocks.searchParams = { 'query-public-key': '' };
        let queryRenderer: any;
        act(() => {
            queryRenderer = TestRenderer.create(<TerminalScreen />);
        });

        const queryAccept = queryRenderer.root.findAllByType('RoundButton')
            .find((node: any) => node.props.title === 'terminal.acceptConnection');
        expect(queryAccept).toBeDefined();
        await act(async () => queryAccept?.props.onPress());
        expect(mocks.processAuthUrl).toHaveBeenCalledWith('paws://terminal?query-public-key');

        mocks.processAuthUrl.mockClear();
        window.location.hash = '#key=hash-public-key';
        let hashRenderer: any;
        act(() => {
            hashRenderer = TestRenderer.create(<TerminalConnectScreen />);
        });

        const hashAccept = hashRenderer.root.findAllByType('RoundButton')
            .find((node: any) => node.props.title === 'terminal.acceptConnection');
        expect(hashAccept).toBeDefined();
        await act(async () => hashAccept?.props.onPress());
        expect(mocks.processAuthUrl).toHaveBeenCalledWith('paws://terminal?hash-public-key');

        act(() => {
            queryRenderer.unmount();
            hashRenderer.unmount();
        });
    });
});
