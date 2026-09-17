import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    firstActionFocus: vi.fn(),
    keydownCapture: false,
    keydownHandler: null as ((event: any) => void) | null,
    logout: vi.fn(),
    navigate: vi.fn(),
    platform: 'web',
    triggerFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            focus: props.testID === 'sidebar-account-trigger'
                ? mocks.triggerFocus
                : props.testID === 'sidebar-account-profile-action'
                    ? mocks.firstActionFocus
                    : vi.fn(),
        }), [props.testID]);
        return ReactModule.createElement('Pressable', props, props.children);
    });

    return {
        Modal: ({ children, visible }: any) => visible ? ReactModule.createElement('Modal', null, children) : null,
        Platform: { get OS() { return mocks.platform; } },
        Pressable,
        Text: 'Text',
        ScrollView: 'ScrollView',
        useWindowDimensions: () => ({ height: 900, width: 1280 }),
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }) }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            groupped: { background: '#f5f5f5' },
            shadow: { color: '#000', opacity: 0.2 },
            status: { error: '#f00' },
            surface: '#fff',
            surfacePressed: '#eee',
            text: '#111',
            textSecondary: '#666',
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
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ logout: mocks.logout }) }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/components/accounts/SavedAccountsMenu', async () => {
    const ReactModule = await import('react');
    return { SavedAccountsMenu: ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({ focus: mocks.firstActionFocus }));
        return ReactModule.createElement('SavedAccountsMenu', props);
    }) };
});
vi.mock('react-native-reanimated', () => {
    const animation = { duration: () => animation, reduceMotion: () => animation, withCallback: () => animation };
    return { default: { View: 'View' }, FadeIn: animation, LinearTransition: animation, ReduceMotion: { System: 'system' } };
});
vi.mock('@/components/usage/UsagePanel', () => ({ UsagePanel: 'UsagePanel' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/sync/profile', () => ({ getAvatarUrl: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { SidebarAccountMenu } from './SidebarAccountMenu';

const profile = {
    id: 'user-1',
    timestamp: 0,
    firstName: 'Paws',
    lastName: 'User',
    avatar: null,
    github: null,
    connectedServices: [],
};

function AccountMenuHarness() {
    const [open, setOpen] = React.useState(false);
    return (
        <SidebarAccountMenu
            displayName="Paws User"
            onNavigate={mocks.navigate}
            onOpenChange={setOpen}
            open={open}
            profile={profile}
        />
    );
}

describe('SidebarAccountMenu', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.platform = 'web';
        mocks.keydownCapture = false;
        mocks.keydownHandler = null;
        vi.stubGlobal('window', {
            addEventListener: vi.fn((event: string, handler: (event: any) => void, capture?: boolean) => {
                if (event === 'keydown') {
                    mocks.keydownCapture = capture === true;
                    mocks.keydownHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('places native mobile actions in a full-screen modal outside the narrow rail touch bounds', () => {
        mocks.platform = 'android';
        const changeOpen = vi.fn();
        act(() => { renderer = TestRenderer.create(<SidebarAccountMenu mobileRail railMode displayName="Paws" onNavigate={mocks.navigate} onOpenChange={changeOpen} open profile={profile} />); });
        const modal = renderer.root.findByType('Modal');
        act(() => modal.findByProps({ testID: 'sidebar-account-settings-action' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/settings');
        expect(changeOpen).toHaveBeenCalledWith(false);
        act(() => modal.findByProps({ testID: 'sidebar-account-native-dismiss' }).props.onPress());
        expect(changeOpen).toHaveBeenCalledTimes(2);
    });

    it('focuses the first action, closes on Escape, and restores trigger focus', () => {
        act(() => {
            renderer = TestRenderer.create(<AccountMenuHarness />);
        });

        const trigger = renderer.root.findByProps({ testID: 'sidebar-account-trigger' });
        act(() => trigger.props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-menu' })).toHaveLength(1);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.firstActionFocus).toHaveBeenCalledOnce();

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();
        act(() => mocks.keydownHandler?.({
            key: 'Escape',
            preventDefault,
            stopImmediatePropagation,
            stopPropagation,
        }));
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-menu' })).toHaveLength(0);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(mocks.keydownCapture).toBe(true);
    });

    it('does not restore its trigger while focus transfers to another footer menu', () => {
        const onOpenChange = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={onOpenChange}
                    open
                    profile={profile}
                    restoreFocusOnClose={false}
                />,
            );
        });
        act(() => vi.runOnlyPendingTimers());
        mocks.triggerFocus.mockClear();

        act(() => renderer.update(
            <SidebarAccountMenu
                displayName="Paws User"
                onNavigate={mocks.navigate}
                onOpenChange={onOpenChange}
                open={false}
                profile={profile}
                restoreFocusOnClose={false}
            />,
        ));
        act(() => vi.runOnlyPendingTimers());

        expect(mocks.triggerFocus).not.toHaveBeenCalled();
    });

    it('focuses the trigger before opening desktop settings so modal close can restore it', () => {
        const events: string[] = [];
        const onOpenSettings = vi.fn(() => events.push('open-settings'));
        mocks.triggerFocus.mockImplementation(() => events.push('focus-trigger'));
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={vi.fn()}
                    onOpenSettings={onOpenSettings}
                    open
                    profile={profile}
                />,
            );
        });

        act(() => renderer.root.findByProps({ testID: 'sidebar-account-settings-action' }).props.onPress());

        expect(events).toEqual(['focus-trigger', 'open-settings']);
    });

    it('keeps usage as the single outer account-menu entry and opens the shared route', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={vi.fn()}
                    open
                    profile={profile}
                />,
            );
        });

        const usageAction = renderer.root.findByProps({ testID: 'sidebar-account-usage-action' });
        act(() => usageAction.props.onPress());

        expect(mocks.navigate).toHaveBeenCalledWith('/settings/usage');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-usage-dialog' })).toHaveLength(0);
    });

    it('preserves the other account destinations and action order', () => {
        const openAccounts = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={vi.fn()}
                    {...{ onOpenAccounts: openAccounts } as any}
                    open
                    profile={profile}
                />,
            );
        });

        const menu = renderer.root.findByProps({ testID: 'sidebar-account-menu' });
        const actionOrder = menu.findAllByType('Pressable').map((node: any) => node.props.testID);
        expect(actionOrder).toEqual([
            'sidebar-account-settings-action',
            'sidebar-account-details-action',
            'sidebar-account-usage-action',
            'sidebar-account-logout-action',
        ]);

        act(() => renderer.root.findByProps({ testID: 'sidebar-account-settings-action' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-account-details-action' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-account-usage-action' }).props.onPress());
        expect(mocks.navigate.mock.calls).toEqual([
            ['/settings'],
            ['/settings/usage'],
        ]);
        expect(openAccounts).toHaveBeenCalledOnce();
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-help-action' })).toHaveLength(0);
    });

    it('opens add-account management in the desktop modal flow', () => {
        const openAccounts = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={vi.fn()}
                    {...{ onOpenAccounts: openAccounts } as any}
                    open
                    profile={profile}
                />,
            );
        });

        act(() => renderer.root.findByType('SavedAccountsMenu').props.onNavigate('/accounts?add=1'));

        expect(openAccounts).toHaveBeenCalledExactlyOnceWith(true);
        expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('uses the pressed surface for Web hover and press states', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={vi.fn()}
                    open
                    profile={profile}
                />,
            );
        });

        const findSettingsPressable = () => renderer.root
            .findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-account-settings-action');
        let settingsAction = findSettingsPressable();
        expect(settingsAction).toBeDefined();
        expect(settingsAction.props.style({ pressed: false })).not.toContainEqual(
            expect.objectContaining({ backgroundColor: '#eee' }),
        );

        act(() => settingsAction.props.onHoverIn());
        settingsAction = findSettingsPressable();
        expect(settingsAction.props.style({ pressed: false })).toContainEqual(
            expect.objectContaining({ backgroundColor: '#eee' }),
        );

        act(() => settingsAction.props.onHoverOut());
        settingsAction = findSettingsPressable();
        expect(settingsAction.props.style({ pressed: true })).toContainEqual(
            expect.objectContaining({ backgroundColor: '#eee' }),
        );
    });

    it('aligns the expanded menu with the account trigger at each density', () => {
        const onOpenChange = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={onOpenChange}
                    open
                    profile={profile}
                />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'sidebar-account-menu' }).props.style).toContainEqual(
            expect.objectContaining({ left: 16, right: 16 }),
        );

        act(() => renderer.update(
            <SidebarAccountMenu
                desktopDensity
                displayName="Paws User"
                onNavigate={mocks.navigate}
                onOpenChange={onOpenChange}
                open
                profile={profile}
            />,
        ));

        expect(renderer.root.findByProps({ testID: 'sidebar-account-menu' }).props.style).toContainEqual(
            expect.objectContaining({ left: 10, right: 10 }),
        );
    });

    it('logs out only after destructive confirmation', async () => {
        mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const onOpenChange = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarAccountMenu
                    displayName="Paws User"
                    onNavigate={mocks.navigate}
                    onOpenChange={onOpenChange}
                    open
                    profile={profile}
                />,
            );
        });

        await act(async () => {
            renderer.root.findByProps({ testID: 'sidebar-account-logout-action' }).props.onPress();
            await Promise.resolve();
        });
        expect(mocks.logout).not.toHaveBeenCalled();

        await act(async () => {
            renderer.root.findByProps({ testID: 'sidebar-account-logout-action' }).props.onPress();
            await Promise.resolve();
        });
        expect(mocks.confirm).toHaveBeenCalledWith(
            'common.logout',
            'settingsAccount.logoutConfirm',
            { confirmText: 'common.logout', destructive: true },
        );
        expect(mocks.logout).toHaveBeenCalledOnce();
    });
});
