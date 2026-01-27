import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDialog: () => ({
            Root: (props: any) => React.createElement('DialogRoot', props, props.children),
            Portal: (props: any) => React.createElement('DialogPortal', props, props.children),
            Overlay: (props: any) => React.createElement('DialogOverlay', props, props.children),
            Content: (props: any) => React.createElement('DialogContent', props, props.children),
            Title: (props: any) => React.createElement('DialogTitle', props, props.children),
        }),
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
            DismissableLayerBranch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');

    class AnimatedValue {
        constructor(_value: number) {}
        interpolate(_config: unknown) {
            return 0;
        }
    }

    const Animated: any = {
        Value: AnimatedValue,
        timing: () => ({ start: (cb?: () => void) => cb?.() }),
        spring: () => ({ start: (cb?: () => void) => cb?.() }),
        View: (props: any) => React.createElement('AnimatedView', props, props.children),
    };

    return {
        View: (props: any) => React.createElement('View', props, props.children),
        TouchableWithoutFeedback: (props: any) => React.createElement('TouchableWithoutFeedback', props, props.children),
        KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
        Modal: (props: any) => React.createElement('RNModal', props, props.children),
        Animated,
        Platform: {
            OS: 'web',
            select: (options: any) => options.web ?? options.default,
        },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => styles,
        absoluteFillObject: {},
    },
}));

describe('BaseModal (web)', () => {
    it('renders using Radix Dialog instead of react-native Modal', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement('Child') }),
            );
        });

        expect(tree?.root.findAllByType('DialogRoot' as any).length).toBe(1);
        expect(tree?.root.findAllByType('RNModal' as any).length).toBe(0);
    });

    it('wraps the dialog content in a DismissableLayer Branch (so underlying Vaul/Radix layers don’t dismiss)', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement('Child') }),
            );
        });

        expect(tree?.root.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('renders a DialogTitle for accessibility', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement('Child') }),
            );
        });

        expect(tree?.root.findAllByType('DialogTitle' as any).length).toBe(1);
    });

    it('omits the overlay when showBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, showBackdrop: false, children: React.createElement('Child') }),
            );
        });

        expect(tree?.root.findAllByType('DialogOverlay' as any).length).toBe(0);
    });

    it('prevents outside dismissal when closeOnBackdrop is false', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    BaseModal,
                    { visible: true, closeOnBackdrop: false, onClose: () => {}, children: React.createElement('Child') },
                ),
            );
        });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onPointerDownOutside).toBeTypeOf('function');

        const preventDefault = vi.fn();
        content?.props.onPointerDownOutside({ preventDefault });
        expect(preventDefault).toHaveBeenCalled();
    });

    it('dismisses when clicking the backdrop area (pointer down on the content container itself)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, onClose, children: React.createElement('Child') }),
            );
        });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const target = {};
        content?.props.onClick({ target, currentTarget: target, preventDefault: () => {}, stopPropagation: () => {} });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss when clicking inside the modal content', async () => {
        const { BaseModal } = await import('./BaseModal');

        const onClose = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, onClose, children: React.createElement('Child') }),
            );
        });

        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];
        expect(content?.props.onClick).toBeTypeOf('function');

        const currentTarget = {};
        const innerTarget = {};
        content?.props.onClick({ target: innerTarget, currentTarget, preventDefault: () => {}, stopPropagation: () => {} });

        expect(onClose).toHaveBeenCalledTimes(0);
    });

    it('sets the centering container to pointerEvents=\"box-none\" so backdrop clicks are not swallowed by RN-web wrappers', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement('Child') }),
            );
        });

        const container = tree?.root.findAllByType('KeyboardAvoidingView' as any)?.[0];
        expect(container?.props.pointerEvents).toBe('box-none');
    });

    it('sets the wrapper around children to pointerEvents=\"box-none\" so clicks outside the card dismiss (instead of hitting a full-width View)', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement('Child') }),
            );
        });

        const child = tree?.root.findByType('Child' as any);
        const wrapper = (child as any)?.parent;

        expect(wrapper?.type).toBe('View');
        expect(wrapper?.props.pointerEvents).toBe('box-none');
    });

    it('applies zIndexBase to the overlay and content so stacked modals layer correctly', async () => {
        const { BaseModal } = await import('./BaseModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(BaseModal, {
                    visible: true,
                    zIndexBase: 1234,
                    children: React.createElement('Child'),
                }),
            );
        });

        const overlay = tree?.root.findAllByType('DialogOverlay' as any)?.[0];
        const content = tree?.root.findAllByType('DialogContent' as any)?.[0];

        expect(overlay?.props.style?.zIndex).toBe(1234);
        expect(content?.props.style?.zIndex).toBe(1235);
    });

    it('provides a modal portal target to descendants (so popovers can portal inside the dialog subtree)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const portalHostMock = { nodeType: 1 } as any;
        let observedTarget: any = undefined;

        function Probe() {
            observedTarget = useModalPortalTarget();
            return React.createElement('Probe');
        }

        act(() => {
            renderer.create(
                React.createElement(BaseModal, { visible: true, children: React.createElement(Probe) }),
                {
                    createNodeMock: (element: any) => {
                        if (element?.props?.['data-happy-modal-portal-host'] !== undefined) {
                            return portalHostMock;
                        }
                        return null;
                    },
                },
            );
        });

        expect(observedTarget).toBe(portalHostMock);
    });
});
