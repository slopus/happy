import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    paletteClose: undefined as undefined | ((afterClose?: () => void) => void),
}));

vi.mock('@/components/CommandPalette/CommandPaletteModal', () => ({
    CommandPaletteModal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/CommandPalette', () => ({
    CommandPalette: ({ onClose }: { onClose: (afterClose?: () => void) => void }) => {
        mocks.paletteClose = onClose;
        return null;
    },
}));

import { CommandPalette } from '@/components/CommandPalette';
import { CustomModal } from './CustomModal';

describe('CustomModal command palette close order', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.paletteClose = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('runs a selected command only in the task after the palette has unmounted', () => {
        const events: string[] = [];
        const onClose = vi.fn(() => events.push('provider-close'));
        const action = vi.fn(() => events.push('command-action'));
        let renderer: TestRenderer.ReactTestRenderer;

        act(() => {
            renderer = TestRenderer.create(
                <CustomModal
                    config={{
                        id: 'command-palette',
                        type: 'custom',
                        component: CommandPalette,
                        props: { commands: [] },
                    }}
                    onClose={onClose}
                />,
            );
        });

        act(() => mocks.paletteClose?.(action));
        expect(events).toEqual(['provider-close']);

        act(() => renderer!.unmount());
        expect(events).toEqual(['provider-close']);

        act(() => vi.advanceTimersByTime(0));
        expect(events).toEqual(['provider-close', 'command-action']);
    });
});
