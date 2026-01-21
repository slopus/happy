import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/ops', () => {
    return {
        machinePreviewEnv: vi.fn(async () => {
            // Keep the request pending so the hook stays "loading".
            // This is a true system boundary (daemon RPC) so mocking is appropriate.
            await new Promise(() => {});
            return { supported: true, response: { values: {}, policy: 'redacted' } };
        }),
        machineBash: vi.fn(async () => {
            await new Promise(() => {});
            return { success: false, error: 'not used' };
        }),
    };
});

describe('useEnvironmentVariables (hook)', () => {
    it('sets isLoading=true before consumer useEffect can run', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        let latestIsLoading: boolean | null = null;

        function Test() {
            const res = useEnvironmentVariables('m1', ['OPENAI_API_KEY']);
            latestIsLoading = res.isLoading;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latestIsLoading).toBe(true);
    });
});

