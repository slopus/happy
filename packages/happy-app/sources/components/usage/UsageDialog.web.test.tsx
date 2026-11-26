// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    // react-native-web does not publish TypeScript declarations.
    // @ts-expect-error The test intentionally exercises its DOM runtime.
    return import('react-native-web');
});
// Keep the native safe-area entry point out of the jsdom DOM-runtime test.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        absoluteFillObject: {},
        hairlineWidth: 1,
        create: (factory: any) => factory({ colors: {
            divider: '#ddd', shadow: { color: '#000', opacity: 0.2 }, surface: '#fff',
            surfacePressed: '#eee', surfaceSelected: '#ddd', text: '#111', textSecondary: '#666',
        } }),
    },
}));
vi.mock('@/text', () => ({
    t: (key: string) => key === 'settings.usage' ? 'Usage' : 'Close usage',
}));
vi.mock('./UsagePanel', () => ({ UsagePanel: () => <>
    <button data-testid="usage-action">usage</button>
    <div inert><button data-testid="inert-action">hidden panel control</button></div>
    <div aria-hidden="true"><button data-testid="hidden-action">hidden calendar control</button></div>
</> }));

import { UsageDialog } from './UsageDialog';

describe('UsageDialog web dialog semantics', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('renders one named modal owner without a duplicate inner dialog', async () => {
        const onClose = vi.fn();
        await act(async () => {
            root.render(<UsageDialog onClose={onClose} open />);
        });

        const dialogs = document.querySelectorAll('[role="dialog"]');
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0]?.getAttribute('aria-label')).toBe('Usage');
        expect(dialogs[0]?.getAttribute('aria-modal')).toBe('true');

        const inner = document.querySelector('[data-testid="sidebar-account-usage-dialog"]');
        expect(inner?.getAttribute('role')).toBeNull();
        expect(inner?.getAttribute('aria-modal')).toBeNull();
        expect(inner?.getAttribute('aria-label')).toBeNull();

        const backdrop = document.querySelector<HTMLElement>('[data-testid="sidebar-account-usage-dialog-backdrop"]');
        expect(backdrop?.tabIndex).toBe(-1);

        const close = document.querySelector<HTMLElement>('[data-testid="sidebar-account-usage-dialog-close"]');
        const usageAction = document.querySelector<HTMLElement>('[data-testid="usage-action"]');
        close?.focus();
        act(() => close?.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Tab',
            shiftKey: true,
        })));
        expect(document.activeElement).toBe(usageAction);

        act(() => usageAction?.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Tab',
        })));
        expect(document.activeElement).toBe(close);

        act(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })));
        expect(onClose).toHaveBeenCalledOnce();
    });
});
