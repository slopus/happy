import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View') };
});

vi.mock('@expo/ui/jetpack-compose', async () => {
    const ReactModule = await import('react');
    const component = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    const DropdownMenu = component('ExpoDropdownMenu') as any;
    DropdownMenu.Items = component('ExpoDropdownMenuItems');
    DropdownMenu.Trigger = component('ExpoDropdownMenuTrigger');
    const DropdownMenuItem = component('ExpoDropdownMenuItem') as any;
    DropdownMenuItem.Text = component('ExpoDropdownMenuItemText');
    return { DropdownMenu, DropdownMenuItem };
});

import { NativeSettingsMenu } from './NativeSettingsMenu.android';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(element);
    });
    return renderer;
}

describe('Android Expo-native settings menu', () => {
    it('passes disabled state to menu items and keeps enabled selection wired', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'model',
                label: 'Model',
                selectedKey: 'ready',
                options: [
                    { key: 'ready', label: 'Ready' },
                    { key: 'unavailable', label: 'Unavailable', disabled: true },
                ],
                onSelect,
            }],
            children: React.createElement('Trigger'),
        }));

        const items = renderer.root.findAllByType('ExpoDropdownMenuItem' as any);
        expect(items).toHaveLength(2);
        expect(items[0].props.enabled).toBe(true);
        expect(items[1].props.enabled).toBe(false);

        act(() => items[0].props.onClick());
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('ready');
    });
});
