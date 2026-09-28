import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { BrowserStepsPopover, getBrowserStepsPopoverLayout } from './BrowserStepsPopover';

const mocks = vi.hoisted(() => ({
    height: 800,
    theme: {
        colors: {
            divider: '#ddd',
            shadow: { color: '#111', opacity: 0.24 },
            surface: '#fff',
            surfaceHigh: '#f4f4f4',
            surfacePressed: '#eee',
            text: '#111',
            textSecondary: '#666',
        },
    },
    width: 1280,
}));

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ height: mocks.height, width: mocks.width }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { absoluteFillObject: {}, hairlineWidth: 1, create: (value: any) => typeof value === 'function' ? value(mocks.theme) : value },
    useUnistyles: () => ({ theme: mocks.theme }),
}));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'rightPanelCapabilityHub.browserProgress.close': 'Close browser progress',
        'rightPanelCapabilityHub.browserProgress.title': 'Browser progress',
    }[key] ?? key),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('./BrowserStepsPanel', () => ({ BrowserStepsPanel: 'BrowserStepsPanel' }));
vi.mock('../SessionImageViewer', () => ({ SessionImageViewer: 'SessionImageViewer' }));
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'GestureHandlerRootView' }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessionMessages: {} }) } }));

const step = {
    createdAt: 1,
    id: 'step-1',
    label: 'Opened the page',
    name: 'step.png',
    ref: 'attachment://step-1',
};

describe('BrowserStepsPopover', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    const originalConsoleError = console.error;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        vi.useRealTimers();
        vi.unstubAllGlobals();
        consoleErrorSpy.mockRestore();
    });

    it('opens every anonymous gallery page using its public URL', () => {
        const steps = [{ ...step, ref: 'https://public.test/one.png' },
            { ...step, id: 'step-2', ref: 'https://public.test/two.png' }];
        act(() => { renderer = TestRenderer.create(<BrowserStepsPopover open onClose={vi.fn()} steps={steps} />); });
        act(() => renderer.root.findByType('BrowserStepsPanel').props.onOpenImage({ uri: steps[0].ref }));
        const gallery = renderer.root.findByType('SessionImageViewer');
        expect(gallery.props.sources.map((source: any) => source.uri)).toEqual(steps.map(item => item.ref));
        expect(gallery.props.sources.every((source: any) => !source.sessionId && !source.attachmentRef)).toBe(true);
        expect(gallery.props.paginate).toBe(false);
        act(() => gallery.props.onClose());
        expect(renderer.root.findAllByType('SessionImageViewer')).toHaveLength(0);
    });

    it('stays out of the tree until opened and renders as a standalone modal dialog', () => {
        act(() => {
            renderer = TestRenderer.create(
                <BrowserStepsPopover open={false} onClose={vi.fn()} sessionId="s1" steps={[step]} />,
            );
        });
        expect(renderer.toJSON()).toBeNull();

        act(() => {
            renderer.update(<BrowserStepsPopover open onClose={vi.fn()} sessionId="s1" steps={[step]} />);
        });
        expect(renderer.root.findByType('Modal').props.transparent).toBe(true);
        expect(renderer.root.findByType('Modal').props.accessibilityLabel).toBe('Browser progress');
        const dialog = renderer.root.findByProps({ testID: 'browser-steps-popover' });
        expect(dialog.props.role).toBeUndefined();
        expect(dialog.props['aria-modal']).toBeUndefined();
        expect(dialog.props.accessibilityLabel).toBeUndefined();
    });

    it('closes on backdrop and close button then restores trigger focus', () => {
        const onClose = vi.fn();
        const triggerFocus = vi.fn();
        const triggerRef = { current: { focus: triggerFocus } };
        act(() => {
            renderer = TestRenderer.create(
                <BrowserStepsPopover open onClose={onClose} returnFocusRef={triggerRef} sessionId="s1" steps={[step]} />,
            );
        });

        act(() => renderer.root.findByProps({ testID: 'browser-steps-popover-backdrop' }).props.onPress());
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => vi.runOnlyPendingTimers());
        expect(triggerFocus).toHaveBeenCalledTimes(1);

        act(() => renderer.root.findByProps({ testID: 'browser-steps-popover-close' }).props.onPress());
        expect(onClose).toHaveBeenCalledTimes(2);

    });

    it('opens the full image inside the existing modal and returns to the timeline without a second modal', () => {
        const onClose = vi.fn();
        act(() => { renderer = TestRenderer.create(<BrowserStepsPopover open onClose={onClose} sessionId="s1" steps={[step]} />); });
        const timeline = renderer.root.findByType('BrowserStepsPanel');
        act(() => renderer.root.findByType('BrowserStepsPanel').props.onOpenImage({ uri: 'blob:step', sessionId: 's1', attachmentRef: step.ref }));
        expect(renderer.root.findAllByType('Modal')).toHaveLength(1);
        expect(renderer.root.findByType('BrowserStepsPanel')).toBe(timeline);
        const viewer = renderer.root.findByType('SessionImageViewer');
        expect(viewer.props.sources[0].attachmentRef).toBe(step.ref);
        expect(viewer.props.sources).toHaveLength(1);
        expect(viewer.props.paginate).toBe(false);
        act(() => viewer.props.onClose());
        expect(renderer.root.findAllByType('SessionImageViewer')).toHaveLength(0);
        expect(renderer.root.findByType('BrowserStepsPanel').props.steps).toEqual([step]);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('rejects images from another session or run in the full-image handler', () => {
        act(() => { renderer = TestRenderer.create(<BrowserStepsPopover open onClose={vi.fn()} sessionId="s1" steps={[step]} />); });
        const open = renderer.root.findByType('BrowserStepsPanel').props.onOpenImage;
        act(() => open({ uri: 'blob:foreign', sessionId: 's2', attachmentRef: step.ref }));
        expect(renderer.root.findAllByType('SessionImageViewer')).toHaveLength(0);
        act(() => open({ uri: 'blob:foreign', sessionId: 's1', attachmentRef: 'another-run' }));
        expect(renderer.root.findAllByType('SessionImageViewer')).toHaveLength(0);
    });

    it('keeps live step updates in the same dialog without stealing focus', () => {
        const triggerFocus = vi.fn();
        const triggerRef = { current: { focus: triggerFocus } };
        act(() => {
            renderer = TestRenderer.create(
                <BrowserStepsPopover open onClose={vi.fn()} returnFocusRef={triggerRef} sessionId="s1" steps={[step]} />,
            );
        });
        act(() => {
            renderer.update(
                <BrowserStepsPopover
                    open
                    onClose={vi.fn()}
                    returnFocusRef={triggerRef}
                    sessionId="s1"
                    steps={[step, { ...step, createdAt: 2, id: 'step-2', label: 'Live update' }]}
                />,
            );
            vi.runOnlyPendingTimers();
        });

        expect(triggerFocus).not.toHaveBeenCalled();
        expect(renderer.root.findByType('BrowserStepsPanel').props.steps).toHaveLength(2);
    });

    it('bounds desktop and narrow layouts to the viewport with internal overflow', () => {
        expect(getBrowserStepsPopoverLayout(
            { height: 30, width: 120, x: 1080, y: 700 },
            { height: 800, width: 1280 },
        )).toEqual({ height: 576, left: 552, top: 116, width: 520 });

        expect(getBrowserStepsPopoverLayout(
            { height: 30, width: 80, x: 270, y: 600 },
            { height: 640, width: 360 },
        )).toEqual({ height: 616, left: 12, top: 12, width: 336 });
    });

    it('keeps a narrow popover clear of Android system bars', () => {
        expect(getBrowserStepsPopoverLayout(
            undefined,
            { height: 760, width: 390 },
            { bottom: 24, left: 0, right: 0, top: 36 },
        )).toEqual({ height: 676, left: 12, top: 48, width: 366 });
    });

    it('uses active theme tokens for the dialog, backdrop, divider, and shadow', () => {
        mocks.theme.colors.surface = '#15171a';
        mocks.theme.colors.divider = '#30343a';
        mocks.theme.colors.shadow = { color: '#020304', opacity: 0.7 };
        act(() => {
            renderer = TestRenderer.create(
                <BrowserStepsPopover open onClose={vi.fn()} sessionId="s1" steps={[step]} />,
            );
        });

        const backdrop = renderer.root.findByProps({ testID: 'browser-steps-popover-backdrop' });
        const card = renderer.root.findByProps({ testID: 'browser-steps-popover' });
        const header = renderer.root.findByProps({ testID: 'browser-steps-popover-header' });
        expect(backdrop.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: '#020304' })]));
        expect(card.props.style).toEqual(expect.arrayContaining([expect.objectContaining({
            backgroundColor: '#15171a',
            borderColor: '#30343a',
            shadowColor: '#020304',
            shadowOpacity: 0.7,
        })]));
        expect(header.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ borderBottomColor: '#30343a' })]));
    });
});
