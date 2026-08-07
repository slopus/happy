import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const viewMock = vi.hoisted(() => ({
    View: 'View',
}));

vi.mock('react-native', () => ({
    StyleSheet: { create: (styles: object) => styles },
    View: viewMock.View,
}));

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

describe('DesktopPresenceTransition.web', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let mediaQuery: ReturnType<typeof createMediaQuery>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
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
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                <View testID="files-content" />
            </DesktopPresenceTransition>,
        ));
        const transitionLayers = renderer.root.findAllByProps({ testID: 'presence-layer' });
        expect(transitionLayers).toHaveLength(2);
        expect(transitionLayers.find((layer: any) => layer.props.dataSet.happyPresencePhase === 'exiting')?.props).toMatchObject({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
            pointerEvents: 'none',
        });

        act(() => vi.advanceTimersByTime(220));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet).toMatchObject({
            happyPresenceDirection: 'forward',
            happyPresencePhase: 'settled',
        });
    });

    it('discards stale outgoing layers and refreshes same-key children without another transition', () => {
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
        act(() => renderer.update(
            <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content-next" />
            </DesktopPresenceTransition>,
        ));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' }).length).toBeLessThanOrEqual(2);
        act(() => vi.advanceTimersByTime(220));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'capabilities-content-next' })).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="capabilities">
                <View testID="capabilities-content-refreshed" />
            </DesktopPresenceTransition>,
        ));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
        expect(renderer.root.findAllByProps({ testID: 'capabilities-content-refreshed' })).toHaveLength(1);

        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" immediate testID="presence" transitionKey="files">
                <View testID="files-immediate" />
            </DesktopPresenceTransition>,
        ));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
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
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(0);
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
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('exiting');
        act(() => vi.advanceTimersByTime(220));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(0);

        mediaQuery.matches = true;
        act(() => mediaQuery.dispatch(true));
        act(() => renderer.update(
            <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="file:src/a.ts">
                <View testID="file-content" />
            </DesktopPresenceTransition>,
        ));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
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

    it('settles only on opacity transitionend and leaves no fallback work after the race', () => {
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

        const activeLayer = renderer.root.findAllByProps({ testID: 'presence-layer' })
            .find((layer: any) => layer.props.dataSet.happyPresencePhase === 'active');
        act(() => activeLayer.props.onTransitionEnd({ nativeEvent: { propertyName: 'transform' } }));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(2);

        act(() => activeLayer.props.onTransitionEnd({ nativeEvent: { propertyName: 'opacity' } }));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
        expect(vi.getTimerCount()).toBe(0);

        act(() => vi.advanceTimersByTime(220));
        expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
    });
});
