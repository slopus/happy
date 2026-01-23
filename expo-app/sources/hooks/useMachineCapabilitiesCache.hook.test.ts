import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

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
            request: { checklistId: 'new-session' } as any,
            timeoutMs: 1,
        })).resolves.toBeUndefined();

        let latest: any = null;
        function Test() {
            latest = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: false,
                request: { checklistId: 'new-session' } as any,
                timeoutMs: 1,
            }).state;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.status).toBe('error');
    });
});

