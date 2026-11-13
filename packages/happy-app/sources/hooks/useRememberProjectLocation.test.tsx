import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ focused: true, current: true, saved: null as string | null, save: vi.fn() }));
vi.mock('expo-router', async () => {
    const React = await import('react');
    return { useFocusEffect: (callback: () => void) => React.useEffect(() => { if (mock.focused) callback(); }, [callback, mock.focused]) };
});
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mock.current }));
vi.mock('@/sync/storage', () => ({ useLocalSettingMutable: () => [mock.saved, mock.save] }));
import { useRememberProjectLocation } from './useRememberProjectLocation';
let renderer: any;
function Host({ location, enabled = true }: { location: Record<string, unknown>; enabled?: boolean }) { useRememberProjectLocation(location, enabled); return null; }
function render(location: Record<string, unknown>, enabled = true) { act(() => { if (renderer) renderer.update(<Host location={location} enabled={enabled} />); else renderer = TestRenderer.create(<Host location={location} enabled={enabled} />); }); }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.focused = mock.current = true; mock.saved = null; mock.save.mockImplementation((value: string) => { mock.saved = value; }); });
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
it('records the latest focused project location and every explicit parent change', () => {
    render({ machine: 'mac', feature: '/design-ops', task: 'four' });
    expect(mock.saved).toBe('/projects?machine=mac&feature=%2Fdesign-ops&task=four');
    render({ machine: 'mac', feature: '/design-ops' });
    expect(mock.saved).toBe('/projects?machine=mac&feature=%2Fdesign-ops');
    render({ machine: 'mac' }); expect(mock.saved).toBe('/projects?machine=mac');
});
it('a retained background project screen cannot overwrite its last location while another route is active', () => {
    render({ machine: 'mac', feature: '/design-ops' });
    mock.focused = false; render({ machine: 'other', feature: '/different' });
    expect(mock.saved).toBe('/projects?machine=mac&feature=%2Fdesign-ops');
    mock.focused = true; render({ machine: 'mac', feature: '/design-ops', conversation: 'new-chat' });
    expect(mock.saved).toBe('/projects?machine=mac&feature=%2Fdesign-ops&conversation=new-chat');
});
it('does not persist updates from a frozen account runtime', () => { mock.current = false; render({ feature: '/old-account' }); expect(mock.save).not.toHaveBeenCalled(); });
it('leaves native navigation outside the desktop memory contract', () => { render({ feature: '/native' }, false); expect(mock.save).not.toHaveBeenCalled(); });
it('does not instantiate browser query APIs when memory is disabled on native', () => {
    vi.stubGlobal('URLSearchParams', class { constructor() { throw new Error('Unsupported native URLSearchParams'); } });
    expect(() => render({ feature: '/native' }, false)).not.toThrow();
    expect(mock.save).not.toHaveBeenCalled();
});
it('does not repeatedly write an unchanged route or erase a saved route on unmount', () => {
    render({ machine: 'mac', feature: '/design-ops' });
    render({ machine: 'mac', feature: '/design-ops' });
    expect(mock.save).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount()); renderer = undefined;
    expect(mock.saved).toBe('/projects?machine=mac&feature=%2Fdesign-ops');
});
