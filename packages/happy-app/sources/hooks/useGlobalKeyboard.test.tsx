import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this hook harness.
import TestRenderer from 'react-test-renderer';

const listeners = vi.hoisted(() => new Map<string, EventListener>());

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

import { useGlobalKeyboard } from './useGlobalKeyboard';

function KeyboardHarness({
    onCommandPalette,
    onOpenSettings,
    onToggleLeftSidebar,
    onToggleRightSidebar,
}: {
    onCommandPalette: () => void;
    onOpenSettings: () => void;
    onToggleLeftSidebar: () => void;
    onToggleRightSidebar: () => void;
}) {
    useGlobalKeyboard(onCommandPalette, { onOpenSettings, onToggleLeftSidebar, onToggleRightSidebar });
    return null;
}

describe('useGlobalKeyboard', () => {
    let renderer: any;
    const onCommandPalette = vi.fn();
    const onOpenSettings = vi.fn();
    const onToggleLeftSidebar = vi.fn();
    const onToggleRightSidebar = vi.fn();

    beforeEach(() => {
        listeners.clear();
        vi.clearAllMocks();
        vi.stubGlobal('window', {
            addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        });
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        act(() => {
            renderer = TestRenderer.create(
                <KeyboardHarness
                    onCommandPalette={onCommandPalette}
                    onOpenSettings={onOpenSettings}
                    onToggleLeftSidebar={onToggleLeftSidebar}
                    onToggleRightSidebar={onToggleRightSidebar}
                />,
            );
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        vi.unstubAllGlobals();
    });

    function keydown(overrides: Partial<KeyboardEvent>): { preventDefault: ReturnType<typeof vi.fn> } {
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        listeners.get('keydown')?.({
            altKey: false,
            ctrlKey: false,
            key: '',
            metaKey: true,
            preventDefault,
            stopPropagation,
            ...overrides,
        } as unknown as Event);
        return { preventDefault };
    }

    it('maps Command+B and Option+Command+B to separate desktop panels', () => {
        expect(keydown({ key: 'b' }).preventDefault).toHaveBeenCalledOnce();
        expect(onToggleLeftSidebar).toHaveBeenCalledOnce();
        expect(onToggleRightSidebar).not.toHaveBeenCalled();

        expect(keydown({ altKey: true, key: 'B' }).preventDefault).toHaveBeenCalledOnce();
        expect(onToggleRightSidebar).toHaveBeenCalledOnce();
        expect(onToggleLeftSidebar).toHaveBeenCalledOnce();
    });

    it('maps Ctrl+B and Alt+Ctrl+B on non-Mac keyboards', () => {
        expect(keydown({ ctrlKey: true, key: 'b', metaKey: false }).preventDefault).toHaveBeenCalledOnce();
        expect(onToggleLeftSidebar).toHaveBeenCalledOnce();
        expect(onToggleRightSidebar).not.toHaveBeenCalled();

        expect(keydown({ altKey: true, ctrlKey: true, key: 'B', metaKey: false }).preventDefault).toHaveBeenCalledOnce();
        expect(onToggleRightSidebar).toHaveBeenCalledOnce();
        expect(onToggleLeftSidebar).toHaveBeenCalledOnce();
    });

    it('maps both Command+K and Ctrl+K to the command palette', () => {
        keydown({ key: 'k' });
        expect(onCommandPalette).toHaveBeenCalledOnce();

        keydown({ ctrlKey: true, key: 'K', metaKey: false });
        expect(onCommandPalette).toHaveBeenCalledTimes(2);
    });

    it('opens app settings instead of the browser settings for Command+Comma', () => {
        const event = keydown({ key: ',' });

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(onOpenSettings).toHaveBeenCalledOnce();
    });
});
