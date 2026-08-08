import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    element: {
        animate: vi.fn(),
    },
    reduceMotion: false,
    transform: 'none',
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const View = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => mocks.element);
        return ReactModule.createElement('View', props, props.children);
    });
    return { View };
});

import { Shaker, type ShakeInstance } from './Shaker.web';

function createAnimation() {
    return {
        cancel: vi.fn(),
        finished: new Promise<void>(() => undefined),
    };
}

describe('Shaker.web', () => {
    let renderer: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.reduceMotion = false;
        mocks.transform = 'none';
        vi.stubGlobal('window', {
            getComputedStyle: vi.fn(() => ({ transform: mocks.transform })),
            matchMedia: vi.fn(() => ({ matches: mocks.reduceMotion })),
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        vi.unstubAllGlobals();
    });

    it('restarts from the current offset and cancels the prior animation', () => {
        const firstAnimation = createAnimation();
        const secondAnimation = createAnimation();
        mocks.element.animate
            .mockReturnValueOnce(firstAnimation)
            .mockReturnValueOnce(secondAnimation);
        mocks.transform = 'matrix(1, 0, 0, 1, 2, 0)';
        const ref = React.createRef<ShakeInstance>();

        act(() => {
            renderer = TestRenderer.create(<Shaker ref={ref} />);
        });
        act(() => ref.current?.shake());

        expect(mocks.element.animate.mock.calls[0]?.[0]?.[0]).toEqual({ transform: 'translateX(2px)' });
        mocks.transform = 'matrix(1, 0, 0, 1, -1, 0)';
        act(() => ref.current?.shake());

        expect(firstAnimation.cancel).toHaveBeenCalledOnce();
        expect(mocks.element.animate.mock.calls[1]?.[0]?.[0]).toEqual({ transform: 'translateX(-1px)' });
        expect(mocks.element.animate.mock.calls[1]?.[1]).toMatchObject({ duration: 260 });

        act(() => renderer.unmount());
        renderer = undefined;
        expect(secondAnimation.cancel).toHaveBeenCalledOnce();
    });

    it('uses opacity feedback when reduced motion is requested', () => {
        const animation = createAnimation();
        mocks.element.animate.mockReturnValueOnce(animation);
        mocks.reduceMotion = true;
        const ref = React.createRef<ShakeInstance>();

        act(() => {
            renderer = TestRenderer.create(<Shaker ref={ref} />);
        });
        act(() => ref.current?.shake());

        expect(mocks.element.animate).toHaveBeenCalledWith(
            [{ opacity: 1 }, { opacity: 0.72 }, { opacity: 1 }],
            expect.objectContaining({ duration: 160 }),
        );
    });
});
