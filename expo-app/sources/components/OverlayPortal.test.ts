import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react');
    return {
        StyleSheet: {
            absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        },
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

describe('OverlayPortalProvider', () => {
    it('does not re-render its children when portal nodes change', async () => {
        const { OverlayPortalHost, OverlayPortalProvider, useOverlayPortal } = await import('./OverlayPortal');

        let renderCount = 0;
        let dispatch: ReturnType<typeof useOverlayPortal> | null = null;

        function RenderCountChild() {
            renderCount += 1;
            return React.createElement('RenderCountChild');
        }

        function CaptureDispatch() {
            dispatch = useOverlayPortal();
            return React.createElement('CaptureDispatch');
        }

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(RenderCountChild),
                    React.createElement(CaptureDispatch),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        expect(renderCount).toBe(1);
        expect(dispatch).toBeTruthy();

        act(() => {
            dispatch?.setPortalNode('test-node', React.createElement('PortalContent'));
        });

        expect(tree?.root.findAllByType('PortalContent' as any).length).toBe(1);
        expect(renderCount).toBe(1);
    });
});

