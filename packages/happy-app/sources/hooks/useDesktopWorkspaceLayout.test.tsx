import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer ships without declarations.
import TestRenderer from 'react-test-renderer';
import { DesktopWorkspaceLayoutProvider, useDesktopWorkspaceLayout } from './useDesktopWorkspaceLayout';

const storage = vi.hoisted(() => ({ values: {} as Record<string, boolean | number>, writes: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1100, height: 900 }) }));
vi.mock('expo-router', () => ({ usePathname: () => '/', useRootNavigationState: () => undefined }));
vi.mock('@/navigation/desktopModalRouter', () => ({ getDesktopModalBackgroundPath: () => undefined }));
vi.mock('@/hooks/useGlobalKeyboard', () => ({ useGlobalKeyboard: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/storage', async () => {
    const React = await import('react');
    return { useLocalSettingMutable: (key: string) => {
        const [value, setValue] = React.useState(storage.values[key]);
        const write = React.useCallback((next: boolean | number) => {
            storage.values[key] = next;
            storage.writes(key, next);
            setValue(next);
        }, [key]);
        return [value, write];
    } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('desktop workspace sidebar integration', () => {
    let renderer: any;
    let layout: ReturnType<typeof useDesktopWorkspaceLayout>;
    function Consumer() { layout = useDesktopWorkspaceLayout(); return null; }
    function mount() {
        act(() => { renderer = TestRenderer.create(<DesktopWorkspaceLayoutProvider enabled><Consumer /></DesktopWorkspaceLayoutProvider>); });
    }
    beforeEach(() => {
        vi.useFakeTimers();
        storage.writes.mockClear();
        storage.values = { zenMode: false, desktopLeftSidebarCollapsed: true, desktopRightPanelCollapsed: false, desktopLeftSidebarWidth: 360, desktopRightPanelWidth: 320 };
        mount();
    });
    afterEach(() => { act(() => renderer.unmount()); vi.useRealTimers(); });

    it('grows the unpinned overlay with keyboard and pointer at 1100px without shrinking chat or the right panel', () => {
        act(() => layout.setLeftSidebarHovered(true));
        expect(layout.leftExpandedWidth).toBe(360);
        expect(layout.leftMaximumWidth).toBe(480);
        expect(layout.rightWidth).toBe(320);
        expect(layout.leftWidth).toBe(0);
        act(() => layout.resizePanelBy('left', 16));
        expect(layout.leftExpandedWidth).toBe(376);
        act(() => layout.beginPanelResize('left', 436));
        act(() => layout.continuePanelResize(460));
        expect(layout.leftExpandedWidth).toBe(400);
        expect(layout.rightWidth).toBe(320);
        expect(layout.leftWidth).toBe(0);
        act(() => layout.endPanelResize());
        expect(storage.values.desktopLeftSidebarWidth).toBe(400);
        expect(storage.values.desktopLeftSidebarCollapsed).toBe(true);
    });

    it('unpin dismisses immediately even while pointer or keyboard focus remains engaged', () => {
        act(() => layout.toggleLeftSidebar());
        act(() => layout.setLeftSidebarHovered(true));
        act(() => layout.setLeftSidebarFocused(true));
        act(() => layout.toggleLeftSidebar());
        expect(layout.leftPinned).toBe(false);
        expect(layout.leftVisible).toBe(false);
        act(() => vi.advanceTimersByTime(1000));
        expect(layout.leftVisible).toBe(false);
        act(() => layout.setLeftSidebarHovered(false));
        act(() => layout.setLeftSidebarFocused(false));
        expect(layout.leftVisible).toBe(false);
        act(() => layout.setLeftSidebarHovered(true));
        expect(layout.leftVisible).toBe(true);
    });

    it('unpin ends a live left resize instead of reopening the dismissed sidebar', () => {
        act(() => layout.toggleLeftSidebar());
        act(() => layout.beginPanelResize('left', 300));
        act(() => layout.continuePanelResize(320));
        expect(layout.resizingSide).toBe('left');
        act(() => layout.toggleLeftSidebar());
        expect(layout.leftVisible).toBe(false);
        expect(layout.resizingSide).toBe(null);
        act(() => vi.advanceTimersByTime(1000));
        expect(layout.leftVisible).toBe(false);
    });

    it('writes pin intent, survives remount, and never persists hover or focus reveal', () => {
        act(() => layout.setLeftSidebarHovered(true));
        act(() => layout.setLeftSidebarFocused(true));
        expect(storage.writes).not.toHaveBeenCalled();
        act(() => layout.toggleLeftSidebar());
        expect(storage.writes).toHaveBeenCalledWith('desktopLeftSidebarCollapsed', false);
        expect(layout.leftPinned).toBe(true);
        act(() => renderer.unmount());
        mount();
        expect(layout.leftPinned).toBe(true);
        expect(layout.leftVisible).toBe(true);
        expect(layout.leftWidth).toBeGreaterThan(0);
        act(() => layout.toggleLeftSidebar());
        expect(layout.leftPinned).toBe(false);
        expect(layout.leftVisible).toBe(false);
        act(() => vi.advanceTimersByTime(220));
        expect(layout.leftVisible).toBe(false);
        expect(storage.values.desktopLeftSidebarCollapsed).toBe(true);
    });
});
