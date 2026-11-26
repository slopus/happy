import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    records: new Map<string, { id: string; machineId: string; sessionId?: string }>(),
    version: 0, scope: { key: 'account-a' },
    recordListeners: new Set<() => void>(), scopeListeners: new Set<() => void>(),
    router: { navigate: vi.fn() }, returnToSettings: vi.fn(async (..._args: unknown[]) => {}),
    navigationOptions: null as any, alert: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => mock.router }));
vi.mock('@/modal', () => ({ Modal: { alert: mock.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/accountRuntime', () => ({}));
vi.mock('@/sync/firstSubmissionScope', () => ({
    getFirstSubmissionScope: () => mock.scope,
    subscribeFirstSubmissionScope: (listener: () => void) => { mock.scopeListeners.add(listener); return () => mock.scopeListeners.delete(listener); },
}));
vi.mock('@/sync/roleConfigurationHandoff', () => ({
    readRoleConfiguration: (id: string) => mock.records.get(id) ?? null,
    findRoleConfigurationForSession: (machineId: string, sessionId: string) => [...mock.records.values()].find(record => record.machineId === machineId && record.sessionId === sessionId) ?? null,
    getRoleConfigurationVersion: () => mock.version,
    subscribeRoleConfigurationChanges: (listener: () => void) => { mock.recordListeners.add(listener); return () => mock.recordListeners.delete(listener); },
}));
vi.mock('@/components/delegation/roleConfigurationNavigation', () => ({
    returnToRoleConfigurationSettings: (...args: unknown[]) => mock.returnToSettings(...args),
}));
vi.mock('./useRoleFlowNavigationBack', () => ({
    useRoleFlowNavigationBack: (options: unknown) => { mock.navigationOptions = options; },
}));

import { useRoleConfigurationReturn } from './useRoleConfigurationReturn';
let current: ReturnType<typeof useRoleConfigurationReturn>;
function Probe(props: Parameters<typeof useRoleConfigurationReturn>[0]) { current = useRoleConfigurationReturn(props); return null; }

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mock.records.clear(); mock.recordListeners.clear(); mock.scopeListeners.clear();
    mock.version = 0; mock.scope = { key: 'account-a' }; mock.navigationOptions = null;
    mock.returnToSettings.mockReset(); mock.returnToSettings.mockResolvedValue(undefined); mock.alert.mockReset();
    current = null;
});

describe('role return in the existing workspace', () => {
    it('keeps an explicit return available before first send and flushes the editor before navigating', async () => {
        mock.records.set('rc-draft', { id: 'rc-draft', machineId: 'machine-a' });
        const flush = vi.fn(); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe reference="rc-draft" beforeReturn={flush} />); });
        expect(current?.reference).toBe('rc-draft'); expect(mock.navigationOptions.enabled).toBe(true);
        await act(async () => { await current?.back(); });
        expect(flush).toHaveBeenCalledOnce();
        expect(mock.returnToSettings).toHaveBeenCalledWith(mock.router, 'rc-draft');
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(mock.returnToSettings.mock.invocationCallOrder[0]);
        act(() => renderer.unmount());
    });

    it('finds the bound session after URL compaction, and ignores other machines or ordinary sessions', () => {
        mock.records.set('rc-saved', { id: 'rc-saved', machineId: 'machine-a', sessionId: 'session-a' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe machineId="machine-a" sessionId="session-a" />); });
        expect(current?.reference).toBe('rc-saved'); expect(mock.navigationOptions.enabled).toBe(true);
        act(() => renderer.update(<Probe machineId="machine-b" sessionId="session-a" />));
        expect(current).toBeNull(); expect(mock.navigationOptions.enabled).toBe(false);
        act(() => renderer.update(<Probe machineId="machine-a" sessionId="ordinary" />));
        expect(current).toBeNull();
        act(() => renderer.unmount());
    });

    it('does not expose role controls for an embedded or inactive workspace', () => {
        mock.records.set('rc-saved', { id: 'rc-saved', machineId: 'machine-a', sessionId: 'session-a' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe reference="rc-saved" enabled={false} />); });
        expect(current).toBeNull(); expect(mock.navigationOptions.enabled).toBe(false);
        act(() => renderer.unmount());
    });

    it('responds to session binding and account invalidation without a message or component remount', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe machineId="machine-a" sessionId="session-a" />); });
        expect(current).toBeNull();
        act(() => {
            mock.records.set('rc-new', { id: 'rc-new', machineId: 'machine-a', sessionId: 'session-a' });
            mock.version++; mock.recordListeners.forEach(listener => listener());
        });
        expect(current?.reference).toBe('rc-new');
        act(() => {
            mock.records.clear(); mock.scope = { key: 'account-b' };
            mock.scopeListeners.forEach(listener => listener());
        });
        expect(current).toBeNull(); expect(mock.navigationOptions.enabled).toBe(false);
        act(() => renderer.unmount());
        expect(mock.recordListeners.size).toBe(0); expect(mock.scopeListeners.size).toBe(0);
    });

    it('surfaces a durable return failure through the existing modal', async () => {
        mock.records.set('rc-draft', { id: 'rc-draft', machineId: 'machine-a' });
        mock.returnToSettings.mockRejectedValue(new Error('Storage unavailable')); let renderer: any;
        act(() => { renderer = TestRenderer.create(<Probe reference="rc-draft" />); });
        await act(async () => { await mock.navigationOptions.onBack(); });
        expect(mock.alert).toHaveBeenCalledWith('common.error', 'Storage unavailable');
        expect(current?.reference).toBe('rc-draft');
        act(() => renderer.unmount());
    });
});
