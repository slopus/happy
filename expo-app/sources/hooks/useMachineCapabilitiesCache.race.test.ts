import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { CHECKLIST_IDS } from '@happy/protocol/checklists';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMachineCapabilitiesCache (race)', () => {
  it('does not let older requests overwrite newer loaded state', async () => {
    vi.resetModules();

    const resolvers: Array<(value: any) => void> = [];
    const machineCapabilitiesDetect = vi.fn(async () => {
      return await new Promise((resolve) => {
        resolvers.push(resolve as any);
      });
    });

    vi.doMock('@/sync/ops', () => {
      return { machineCapabilitiesDetect };
    });

    const { prefetchMachineCapabilities, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

    const request = { checklistId: CHECKLIST_IDS.NEW_SESSION, requests: [] } as any;

    const p1 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });
    const p2 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });

    expect(resolvers).toHaveLength(2);

    // Resolve the newer request first (version 2).
    resolvers[1]!({
      supported: true,
      response: {
        protocolVersion: 1,
        results: {
          'dep.test': { ok: true, data: { version: '2' } },
        },
      },
    });
    await p2;

    // Resolve the older request last (version 1).
    resolvers[0]!({
      supported: true,
      response: {
        protocolVersion: 1,
        results: {
          'dep.test': { ok: true, data: { version: '1' } },
        },
      },
    });
    await p1;

    let latest: any = null;
    function Test() {
      latest = useMachineCapabilitiesCache({
        machineId: 'm1',
        enabled: false,
        request,
        timeoutMs: 1,
      }).state;
      return React.createElement('View');
    }

    act(() => {
      renderer.create(React.createElement(Test));
    });

    expect(latest?.status).toBe('loaded');
    expect(latest?.snapshot?.response?.results?.['dep.test']?.data?.version).toBe('2');
  });
});
