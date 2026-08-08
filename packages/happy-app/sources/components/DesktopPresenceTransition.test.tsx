import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

import { DesktopPresenceTransition } from './DesktopPresenceTransition';

describe('DesktopPresenceTransition native passthrough', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('renders only the current child without a retained host', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                    {React.createElement('CurrentChild', { testID: 'current-child' })}
                </DesktopPresenceTransition>,
            );
        });
        expect(renderer.root.findAllByProps({ testID: 'current-child' })).toHaveLength(1);
        expect(renderer.toJSON()).toEqual({
            children: null,
            props: { testID: 'current-child' },
            type: 'CurrentChild',
        });
        act(() => renderer.unmount());
    });
});
