import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { CHECKLIST_IDS } from '@happy/protocol/checklists';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMachineCapabilitiesCache (hook)', () => {
    it('does not leave the cache stuck in loading when detection throws', async () => {
        vi.resetModules();

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect: vi.fn(async () => {
                    throw new Error('boom');
                }),
            };
        });

        const { prefetchMachineCapabilities, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        await expect(prefetchMachineCapabilities({
            machineId: 'm1',
            request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
            timeoutMs: 1,
        })).resolves.toBeUndefined();

        let latest: any = null;
        function Test() {
            latest = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: false,
                request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
                timeoutMs: 1,
            }).state;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.status).toBe('error');
    });

    it('keeps refresh stable when request identity changes and uses latest request', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async (_machineId: string, _request: any) => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        const requestA = { checklistId: CHECKLIST_IDS.NEW_SESSION } as any;
        const requestB = { checklistId: CHECKLIST_IDS.NEW_SESSION } as any;

        let latestRefresh: null | (() => void) = null;

        function Test({ request }: { request: any }) {
            const { refresh } = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: false,
                request,
                timeoutMs: 1,
            });
            latestRefresh = refresh;
            return React.createElement('View');
        }

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(React.createElement(Test, { request: requestA }));
        });
        const refreshA = latestRefresh!;

        act(() => {
            tree!.update(React.createElement(Test, { request: requestB }));
        });
        const refreshB = latestRefresh!;

        expect(refreshB).toBe(refreshA);

        await act(async () => {
            refreshA();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalled();
        expect(machineCapabilitiesDetect.mock.calls[0][1]).toBe(requestB);
    });

    it('uses a longer default timeout for machine-details detection', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async (_machineId: string, _request: any, _opts: any) => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: { checklistId: 'machine-details' } as any,
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        const opts = machineCapabilitiesDetect.mock.calls[0][2];
        expect(typeof opts?.timeoutMs).toBe('number');
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(8000);
    });

    it('exposes the latest snapshot after a prefetch', async () => {
        vi.resetModules();

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect: vi.fn(async () => {
                    return {
                        supported: true,
                        response: {
                            protocolVersion: 1,
                            results: {
                                'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                            },
                        },
                    };
                }),
            };
        });

        const { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        expect(getMachineCapabilitiesSnapshot('m1')).toBeNull();

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
        });

        expect(getMachineCapabilitiesSnapshot('m1')?.response.results).toEqual({
            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
        });
    });

    it('prefetchMachineCapabilitiesIfStale only fetches when stale or missing', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async () => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilitiesIfStale } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        // Fresh cache entry: should be a no-op.
        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        // Force staleness: should fetch again.
        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: -1,
            request: { checklistId: CHECKLIST_IDS.NEW_SESSION } as any,
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);
    });
});
