import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingWidthRail } from './ReadingWidthRail';

// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const props = () => ({
    value: 960,
    min: 800,
    max: 1280,
    label: '正文宽度',
    accentColor: '#88aacc',
    trackColor: '#333333',
    iconColor: '#999999',
    onValueChange: vi.fn(),
    onValueCommit: vi.fn(),
});

describe('ReadingWidthRail', () => {
    beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

    it('previews pointer movement and commits the clamped value once after release outside the rail', () => {
        const input = props();
        const captured = new Set<number>();
        const target = {
            setPointerCapture: (id: number) => captured.add(id),
            hasPointerCapture: (id: number) => captured.has(id),
            releasePointerCapture: (id: number) => captured.delete(id),
        };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ReadingWidthRail {...input} />, {
                createNodeMock: (element: any) => element.props['data-reading-width-track'] === 'true'
                    ? { getBoundingClientRect: () => ({ left: 10, right: 210, width: 200 }) }
                    : null,
            });
        });
        const rail = renderer.root.findByProps({ role: 'slider' });
        act(() => rail.props.onPointerDown({ pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, currentTarget: target }));
        act(() => rail.props.onPointerMove({ pointerId: 1, clientX: 110 }));
        expect(input.onValueChange).toHaveBeenLastCalledWith(1040);
        expect(input.onValueCommit).not.toHaveBeenCalled();
        act(() => rail.props.onPointerUp({ type: 'pointerup', pointerId: 1, clientX: 280, currentTarget: target }));
        act(() => rail.props.onLostPointerCapture({ type: 'lostpointercapture', pointerId: 1, currentTarget: target }));
        expect(input.onValueChange).toHaveBeenLastCalledWith(1280);
        expect(input.onValueCommit).toHaveBeenCalledExactlyOnceWith(1280);
        expect(captured.size).toBe(0);
        act(() => renderer.unmount());
    });

    it('supports keyboard precision and range endpoints', () => {
        const input = props();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ReadingWidthRail {...input} />); });
        const rail = renderer.root.findByProps({ role: 'slider' });
        expect(rail.props).toMatchObject({ 'aria-valuemin': 800, 'aria-valuemax': 1280, 'aria-valuenow': 960 });
        const preventDefault = vi.fn();
        act(() => rail.props.onKeyDown({ key: 'ArrowRight', preventDefault }));
        expect(input.onValueCommit).toHaveBeenLastCalledWith(961);
        act(() => rail.props.onKeyDown({ key: 'End', preventDefault }));
        expect(input.onValueCommit).toHaveBeenLastCalledWith(1280);
        expect(preventDefault).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });
});
