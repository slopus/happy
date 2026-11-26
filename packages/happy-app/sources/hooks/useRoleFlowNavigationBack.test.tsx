import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    focused: true, os: 'web',
    removeListener: vi.fn(), removeHardware: vi.fn(), alert: vi.fn(),
    beforeRemove: null as null | ((event: any) => void), hardware: null as null | (() => boolean),
    prevention: null as null | { enabled: boolean; callback: (event: any) => void },
    navigation: { addListener: vi.fn(), dispatch: vi.fn(), setOptions: vi.fn() },
}));
vi.mock('react-native', () => ({
    Platform: { get OS() { return mock.os; } },
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => { mock.hardware = handler; return { remove: mock.removeHardware }; } },
}));
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => mock.focused,
    useNavigation: () => mock.navigation,
    usePreventRemove: (enabled: boolean, callback: (event: any) => void) => { mock.prevention = { enabled, callback }; },
}));
vi.mock('@/modal', () => ({ Modal: { alert: mock.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { useRoleFlowNavigationBack } from './useRoleFlowNavigationBack';
import { registerRoleFlowNavigation, runRoleFlowNavigationBack, runRoleFlowNavigationClose, useRoleFlowNavigationStore } from '@/navigation/roleFlowNavigation';

function Probe(props: Parameters<typeof useRoleFlowNavigationBack>[0]) { useRoleFlowNavigationBack(props); return null; }
async function flush() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mock.focused = true; mock.os = 'web'; mock.beforeRemove = null; mock.hardware = null; mock.prevention = null;
    mock.navigation.addListener.mockReset(); mock.navigation.dispatch.mockReset(); mock.navigation.setOptions.mockReset();
    mock.removeListener.mockReset(); mock.removeHardware.mockReset(); mock.alert.mockReset();
    mock.navigation.addListener.mockImplementation((_event, listener) => { mock.beforeRemove = listener; return mock.removeListener; });
    useRoleFlowNavigationStore.setState({ entry: null });
});

describe('focused local role navigation', () => {
    it('exposes a host Back even without route history, with separate Back and Close actions', async () => {
        const onBack = vi.fn(); const onClose = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={onBack} onClose={onClose} />); });
        expect(useRoleFlowNavigationStore.getState().entry).not.toBeNull();
        expect(runRoleFlowNavigationBack()).toBe(true); await flush();
        expect(onBack).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
        expect(runRoleFlowNavigationClose()).toBe(true); await flush();
        expect(onClose).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
        expect(runRoleFlowNavigationBack()).toBe(false);
    });

    it('keeps readonly detail Back local while letting a real modal Close reach its host', async () => {
        const onBack = vi.fn(); const onClose = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled interceptClose={false} onBack={onBack} onClose={onClose} />); });
        expect(runRoleFlowNavigationClose()).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        const close = { data: { action: { type: 'CLOSE_DESKTOP_MODAL' } }, preventDefault: vi.fn() };
        mock.beforeRemove?.(close); await flush();
        expect(close.preventDefault).not.toHaveBeenCalled(); expect(onBack).not.toHaveBeenCalled();
        expect(runRoleFlowNavigationBack()).toBe(true); await flush(); expect(onBack).toHaveBeenCalledOnce();
        act(() => renderer.update(<Probe enabled interceptClose onBack={onBack} onClose={onClose} />));
        expect(runRoleFlowNavigationClose()).toBe(true); await flush(); expect(onClose).toHaveBeenCalledOnce();
        act(() => renderer.update(<Probe enabled interceptClose={false} onBack={onBack} onClose={onClose} />));
        expect(runRoleFlowNavigationClose()).toBe(false);
        act(() => renderer.unmount());
    });

    it('deduplicates asynchronous draft confirmation and reads the latest handler', async () => {
        let release!: () => void;
        const onBack = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
        const latest = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={onBack} />); });
        const owner = useRoleFlowNavigationStore.getState().entry?.owner;
        runRoleFlowNavigationBack(); runRoleFlowNavigationClose(); await flush();
        expect(onBack).toHaveBeenCalledOnce();
        act(() => renderer.update(<Probe enabled onBack={latest} />));
        expect(useRoleFlowNavigationStore.getState().entry?.owner).toBe(owner);
        runRoleFlowNavigationBack(); expect(latest).not.toHaveBeenCalled();
        await act(async () => { release(); await Promise.resolve(); });
        runRoleFlowNavigationBack(); await flush();
        expect(latest).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('releases navigation on blur or unmount and does not let stale cleanup remove a newer owner', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={() => {}} />); });
        const newer = { owner: {}, back: vi.fn(), close: vi.fn() };
        const unregister = registerRoleFlowNavigation(newer);
        mock.focused = false; act(() => renderer.update(<Probe enabled onBack={() => {}} />));
        expect(useRoleFlowNavigationStore.getState().entry).toBe(newer);
        expect(mock.removeListener).toHaveBeenCalledOnce();
        unregister(); expect(useRoleFlowNavigationStore.getState().entry).toBeNull();
        act(() => renderer.unmount());
    });

    it('does not leak a role navigation owner through StrictMode remounts', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<React.StrictMode><Probe enabled onBack={() => {}} /></React.StrictMode>); });
        expect(useRoleFlowNavigationStore.getState().entry).not.toBeNull();
        act(() => renderer.unmount());
        expect(useRoleFlowNavigationStore.getState().entry).toBeNull();
        expect(mock.navigation.addListener.mock.calls.length).toBe(mock.removeListener.mock.calls.length);
    });

    it('intercepts only web route Back/Close actions, leaving forward AI navigation untouched', async () => {
        const onBack = vi.fn(); const onClose = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={onBack} onClose={onClose} />); });
        const event = (type: string) => ({ data: { action: { type } }, preventDefault: vi.fn() });
        const navigate = event('NAVIGATE'); mock.beforeRemove?.(navigate); await flush();
        expect(navigate.preventDefault).not.toHaveBeenCalled(); expect(onBack).not.toHaveBeenCalled();
        const back = event('GO_BACK'); mock.beforeRemove?.(back); await flush();
        expect(back.preventDefault).toHaveBeenCalledOnce(); expect(onBack).toHaveBeenCalledOnce();
        const close = event('CLOSE_DESKTOP_MODAL'); mock.beforeRemove?.(close); await flush();
        expect(close.preventDefault).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
        expect(mock.prevention?.enabled).toBe(false);
        act(() => renderer.unmount());
    });

    it('uses native-stack supported prevention plus the same Android hardware Back path', async () => {
        mock.os = 'android'; const onBack = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={onBack} />); });
        expect(mock.navigation.addListener).not.toHaveBeenCalled();
        expect(mock.prevention?.enabled).toBe(true);
        expect(mock.navigation.setOptions).toHaveBeenCalledWith({ headerBackButtonMenuEnabled: false });
        expect(mock.hardware?.()).toBe(true); await flush();
        expect(onBack).toHaveBeenCalledOnce();
        mock.prevention?.callback({ data: { action: { type: 'POP' } } }); await flush();
        expect(onBack).toHaveBeenCalledTimes(2);
        const forward = { type: 'NAVIGATE', payload: { name: 'new' } };
        mock.prevention?.callback({ data: { action: forward } });
        expect(mock.navigation.dispatch).toHaveBeenCalledWith(forward);
        act(() => renderer.unmount()); expect(mock.removeHardware).toHaveBeenCalledOnce();
    });

    it('reports a failed local transition while keeping the source view usable', async () => {
        const onBack = vi.fn().mockRejectedValue(new Error('Draft unavailable')); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe enabled onBack={onBack} />); });
        runRoleFlowNavigationBack(); await flush();
        expect(mock.alert).toHaveBeenCalledWith('common.error', 'Draft unavailable');
        runRoleFlowNavigationBack(); await flush(); expect(onBack).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });
});
