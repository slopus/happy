import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    firstActionFocus: vi.fn(),
    keydownHandler: null as ((event: any) => void) | null,
    logout: vi.fn(),
    navigate: vi.fn(),
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
        Platform: { OS: 'web' },
        Pressable,
        Text: 'Text',
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
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
        mocks.keydownHandler = null;
        vi.stubGlobal('window', {
            addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
                if (event === 'keydown') mocks.keydownHandler = handler;
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
        act(() => mocks.keydownHandler?.({ key: 'Escape', preventDefault, stopPropagation }));
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-menu' })).toHaveLength(0);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
    });

    it('offers profile, settings, and account destinations without help actions', () => {
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

        act(() => renderer.root.findByProps({ testID: 'sidebar-account-profile-action' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-account-settings-action' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-account-details-action' }).props.onPress());

        expect(mocks.navigate.mock.calls).toEqual([
            ['/settings/profile'],
            ['/settings'],
            ['/settings/account'],
        ]);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-account-help-action' })).toHaveLength(0);
        expect(onOpenChange).toHaveBeenCalledWith(false);
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
