import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { listOrchestratorRuns } from './apiOrchestrator';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://happy.example',
}));

vi.mock('@/utils/time', () => ({
    backoff: async <T>(callback: () => Promise<T>) => callback(),
}));

const credentials: AuthCredentials = {
    token: 'token-1',
    secret: 'secret-1',
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('listOrchestratorRuns', () => {
    it('includes controllerSessionId query when provided', async () => {
        let requestUrl: string | null = null;
        const fetchMock = vi.fn(async (input: unknown) => {
            requestUrl = String(input);
            return {
                ok: true,
                json: async () => ({
                    ok: true,
                    data: {
                        items: [],
                    },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock);

        await listOrchestratorRuns(credentials, {
            status: 'active',
            limit: 20,
            cursor: 'cursor-1',
            controllerSessionId: 'session-123',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(requestUrl).not.toBeNull();
        const parsed = new URL(requestUrl!);
        expect(parsed.pathname).toBe('/v1/orchestrator/runs');
        expect(parsed.searchParams.get('controllerSessionId')).toBe('session-123');
        expect(parsed.searchParams.get('status')).toBe('active');
        expect(parsed.searchParams.get('limit')).toBe('20');
        expect(parsed.searchParams.get('cursor')).toBe('cursor-1');
    });
});
