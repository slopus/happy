import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const viewMock = vi.hoisted(() => {
    const elements = new Set<any>();

    return {
        createElement() {
            const listeners = new Set<(event: { propertyName: string; target: any }) => void>();
            const element = {
                addEventListener(type: string, listener: (event: { propertyName: string; target: any }) => void) {
                    if (type === 'transitionend') listeners.add(listener);
                },
                dispatchTransition(propertyName: string, target?: any) {
                    listeners.forEach((listener) => listener({
                        propertyName,
                        target: target ?? element,
                    }));
                },
                listenerCount() {
                    return listeners.size;
                },
                props: {} as any,
                removeEventListener(type: string, listener: (event: { propertyName: string; target: any }) => void) {
                    if (type === 'transitionend') listeners.delete(listener);
                },
            };
            elements.add(element);
            return element;
        },
        elements,
    };
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const View = ReactModule.forwardRef<any, any>((props, ref) => {
        const elementRef = ReactModule.useRef<any>(null);
        if (elementRef.current === null) elementRef.current = viewMock.createElement();
        elementRef.current.props = props;
        ReactModule.useImperativeHandle(ref, () => elementRef.current, []);
        return ReactModule.createElement('View', props, props.children);
    });

    return {
        StyleSheet: { create: (styles: object) => styles },
        View,
    };
});

import { DesktopPresenceTransition } from './DesktopPresenceTransition.web';

type MediaQueryListener = (event: { matches: boolean }) => void;

function createMediaQuery() {
    const listeners = new Set<MediaQueryListener>();

    return {
        addEventListener: vi.fn((_type: string, listener: MediaQueryListener) => listeners.add(listener)),
        dispatch(matches: boolean) {
            this.matches = matches;
            listeners.forEach((listener) => listener({ matches }));
        },
        listeners,
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        removeEventListener: vi.fn((_type: string, listener: MediaQueryListener) => listeners.delete(listener)),
    };
}

function findLayerElement(phase: string) {
    return [...viewMock.elements].find((element) => (
        element.props.testID === 'presence-layer'
        && element.props.dataSet?.happyPresencePhase === phase
    ));
}

function findHostViews(renderer: any, testID: string) {
    return renderer.root.findAll((node: any) => (
        node.type === 'View' && node.props.testID === testID
    ));
}

function findPresenceLayer(renderer: any) {
    return findHostViews(renderer, 'presence-layer')[0];
}

describe('DesktopPresenceTransition.web', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let mediaQuery: ReturnType<typeof createMediaQuery>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        viewMock.elements.clear();
        mediaQuery = createMediaQuery();
        vi.stubGlobal('window', {
            cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
            matchMedia: vi.fn(() => mediaQuery),
            requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 16),
        });
        vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame);
        vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('retains one inaccessible outgoing layer until the keyed child settles', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        const transitionLayers = findHostViews(renderer, 'presence-layer');
        expect(transitionLayers).toHaveLength(2);
        expect(transitionLayers.find((layer: any) => layer.props.dataSet.happyPresencePhase === 'exiting')?.props).toMatchObject({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
            inert: true,
            pointerEvents: 'none',
        });

        act(() => vi.advanceTimersByTime(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet).toMatchObject({
            happyPresenceDirection: 'forward',
            happyPresencePhase: 'settled',
        });
    });

    it('settles from the fallback when requestAnimationFrame never runs', () => {
        let capturedFrame: FrameRequestCallback | undefined;
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            capturedFrame = callback;
            return 73;
        });
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));

        expect(findHostViews(renderer, 'presence-layer').map((layer: any) => (
            layer.props.dataSet.happyPresencePhase
        ))).toEqual(['exiting', 'entering']);

        act(() => vi.advanceTimersByTime(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(cancelAnimationFrame).toHaveBeenCalledWith(73);
        expect(vi.getTimerCount()).toBe(0);

        act(() => capturedFrame?.(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('restores the matching outgoing layer when a transition reverses before its first frame', () => {
        let capturedFrame: FrameRequestCallback | undefined;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            capturedFrame = callback;
            return 74;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        const originalLayerElement = findLayerElement('settled');

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer').map((layer: any) => (
            layer.props.dataSet.happyPresencePhase
        ))).toEqual(['exiting', 'entering']);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content-restored" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(findLayerElement('settled')).toBe(originalLayerElement);
        expect(findHostViews(renderer, 'capabilities-content-restored')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);

        act(() => capturedFrame?.(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
    });

    it('discards stale interrupted callbacks and refreshes same-key children without another transition', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        act(() => vi.advanceTimersByTime(30));
        const replacedLayerElement = findLayerElement('active');
        expect(replacedLayerElement.listenerCount()).toBe(1);
        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content-next" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer').length).toBeLessThanOrEqual(2);
        expect(replacedLayerElement.listenerCount()).toBe(0);
        act(() => vi.advanceTimersByTime(16));
        act(() => replacedLayerElement.dispatchTransition('opacity'));
        expect(findHostViews(renderer, 'presence-layer').map((layer: any) => (
            layer.props.dataSet.happyPresencePhase
        ))).toEqual(['settled']);
        act(() => vi.advanceTimersByTime(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findHostViews(renderer, 'capabilities-content-next')).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content-refreshed" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(findHostViews(renderer, 'capabilities-content-refreshed')).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" immediate testID="presence" transitionKey="files">
                <View testID="files-immediate" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes null content and collapses synchronously when reduced motion changes', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="chat">
                    {null}
                </DesktopPresenceTransition>,
            );
        });
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(0);
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        act(() => vi.advanceTimersByTime(220));
        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="chat">
                {null}
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('exiting');
        act(() => vi.advanceTimersByTime(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(0);

        mediaQuery.matches = true;
        act(() => mediaQuery.dispatch(true));
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="file:src/a.ts">
                <View testID="file-content" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(vi.getTimerCount()).toBe(0);

        act(() => mediaQuery.dispatch(false));
        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content" />
            </DesktopPresenceTransition>,
        ));
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        act(() => renderer.unmount());
        renderer = undefined;
        expect(mediaQuery.listeners).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels an active transition when reduced motion turns on and ignores stale callbacks', () => {
        let capturedFrame: FrameRequestCallback | undefined;
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            capturedFrame = callback;
            return 91;
        });
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        expect(findHostViews(renderer, 'presence-layer').map((layer: any) => (
            layer.props.dataSet.happyPresencePhase
        ))).toEqual(['exiting', 'entering']);
        const staleIncomingElement = findLayerElement('entering');
        expect(staleIncomingElement.listenerCount()).toBe(1);

        act(() => mediaQuery.dispatch(true));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(findHostViews(renderer, 'files-content')).toHaveLength(1);
        expect(findLayerElement('settled')).toBe(staleIncomingElement);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(91);
        expect(staleIncomingElement.listenerCount()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);

        act(() => capturedFrame?.(220));
        act(() => staleIncomingElement.dispatchTransition('opacity'));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(findHostViews(renderer, 'files-content')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves the settled child tree for same-key updates under reduced motion', () => {
        const mountSpy = vi.fn();
        const unmountSpy = vi.fn();

        function PublishedOverlay({ version }: { version: number }) {
            React.useEffect(() => {
                mountSpy();
                return unmountSpy;
            }, []);
            return <View testID={`published-overlay-${version}`} />;
        }

        mediaQuery.matches = true;
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="diff:src/a.ts">
                    <PublishedOverlay version={1} />
                </DesktopPresenceTransition>,
            );
        });
        const settledElement = findLayerElement('settled');
        expect(mountSpy).toHaveBeenCalledTimes(1);
        expect(unmountSpy).not.toHaveBeenCalled();

        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="diff:src/a.ts">
                <PublishedOverlay version={2} />
            </DesktopPresenceTransition>,
        ));

        expect(findLayerElement('settled')).toBe(settledElement);
        expect(findHostViews(renderer, 'published-overlay-2')).toHaveLength(1);
        expect(mountSpy).toHaveBeenCalledTimes(1);
        expect(unmountSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('settles from the layer DOM opacity listener and removes it on unmount', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                    <View testID="capabilities-content" />
                </DesktopPresenceTransition>,
            );
        });
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        act(() => vi.advanceTimersByTime(16));

        const activeLayer = findHostViews(renderer, 'presence-layer')
            .find((layer: any) => layer.props.dataSet.happyPresencePhase === 'active');
        const activeElement = findLayerElement('active');
        const exitingElement = findLayerElement('exiting');
        expect(activeLayer.props.onTransitionEnd).toBeUndefined();
        expect(activeElement.listenerCount()).toBe(1);
        expect(exitingElement.listenerCount()).toBe(0);

        act(() => activeElement.dispatchTransition('opacity', { parent: activeElement }));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(2);

        act(() => activeElement.dispatchTransition('transform'));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(2);

        act(() => activeElement.dispatchTransition('opacity'));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);
        expect(findPresenceLayer(renderer).props.dataSet.happyPresencePhase).toBe('settled');
        expect(exitingElement.listenerCount()).toBe(0);
        expect(activeElement.listenerCount()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);

        act(() => vi.advanceTimersByTime(220));
        expect(findHostViews(renderer, 'presence-layer')).toHaveLength(1);

        act(() => renderer.unmount());
        renderer = undefined;
        expect(activeElement.listenerCount()).toBe(0);
    });
});
