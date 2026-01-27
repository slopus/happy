import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
}));

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

function PopoverChild() {
    return React.createElement('PopoverChild');
}

describe('PopoverPortalTargetProvider (native)', () => {
    it('renders popovers into a screen-local OverlayPortalHost (avoids coordinate-space mismatch in contained modals)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(200, 200, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inner-root' },
                        React.createElement(
                            PopoverPortalTargetProvider,
                            null,
                            React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                placement: 'bottom',
                                portal: { native: true },
                                onRequestClose: () => {},
                                backdrop: true,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        ),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'outer-host' },
                        React.createElement(OverlayPortalHost),
                    ),
                ),
            );
        });

        const innerRoot = tree?.root.findByProps({ testID: 'inner-root' });
        expect(innerRoot?.findAllByType('PopoverChild' as any).length).toBe(1);
        expect(tree?.root.findByProps({ testID: 'outer-host' }).findAllByType('PopoverChild' as any).length).toBe(0);
    });

});
