import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, getCredentials, ensureSessionHydrated } = vi.hoisted(() => ({
    machineRPC: vi.fn(), getCredentials: vi.fn(), ensureSessionHydrated: vi.fn(),
}));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC }, getHappyClientId: () => 'web' }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://test' }));
vi.mock('./sync', () => ({ sync: { ensureSessionHydrated } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials } }));
import { codexListRewindPoints, forkAndSpawn, machineResumeSession, machineSpawnNewSession } from './ops';

let grants: string[];
let requests: { url: string; body: unknown }[];
beforeEach(() => {
    grants = []; requests = [];
    getCredentials.mockReset().mockResolvedValue({ token: 'paws-bearer', secret: 'paws-secret' });
    ensureSessionHydrated.mockReset().mockResolvedValue(true);
    machineRPC.mockReset().mockResolvedValue({ type: 'success', sessionId: 'paws-new' });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(init.body as string) });
        const grant = String.fromCharCode(97 + grants.length).repeat(43);
        grants.push(grant);
        return new Response(JSON.stringify({ grant, expiresAt: '2026-09-11T00:01:00Z',
            profile: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Work', credentialVersion: 1 } }));
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('transparent Codex grants', () => {
    it('obtains fresh grants for new, retry and native-resume spawns without an account selector', async () => {
        await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex', token: 'legacy-secret' });
        await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex', approvedNewDirectoryCreation: true });
        await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex', resumeCodexThreadId: 't1', parentSessionId: 's1' });
        expect(requests).toEqual(Array(3).fill({ url: 'https://test/v1/codex-session-grants', body: { machineId: 'm1' } }));
        expect(machineRPC.mock.calls.map((call) => call[2].codexSessionGrant)).toEqual(['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)]);
        expect(machineRPC.mock.calls.every((call) => !('token' in call[2]) && !('profileId' in call[2]))).toBe(true);
    });

    it('requests a new machine-bound grant on each Codex session resume', async () => {
        for (let i = 0; i < 2; i++) await machineResumeSession({ machineId: 'm1', sessionId: 's1', agent: 'codex', effort: 'xhigh' });
        expect(requests).toHaveLength(2);
        expect(machineRPC.mock.calls.map((call) => call[2])).toEqual([
            { sessionId: 's1', effort: 'xhigh', codexSessionGrant: 'a'.repeat(43) },
            { sessionId: 's1', effort: 'xhigh', codexSessionGrant: 'b'.repeat(43) },
        ]);
    });

    it.each(['claude', 'ask', 'gemini', 'opencode', 'openclaw'] as const)('never requests a grant for %s spawn or resume', async (agent) => {
        await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent, token: 'existing-agent-token' });
        await machineResumeSession({ machineId: 'm1', sessionId: 's1', agent });
        expect(requests).toHaveLength(0);
        expect(getCredentials).not.toHaveBeenCalled();
        expect(machineRPC.mock.calls[0][2].token).toBe('existing-agent-token');
        expect(machineRPC.mock.calls.every((call) => !('codexSessionGrant' in call[2]))).toBe(true);
    });

    it.each([{}, { cutAfterItemId: 'item-1' }, { cutAfterItemId: 'item-1', retainSelectedTurn: true }])(
        'hands off explicit source history and mints a grant only for the final fork/duplicate spawn (%j)', async (options) => {
            machineRPC.mockImplementation(async (_machine, method) => {
                if (method === 'spawn-happy-session') return { type: 'success', sessionId: 's2' };
                expect(requests).toHaveLength(0);
                return { type: 'success', newCodexThreadId: 't2' };
            });
            expect(await forkAndSpawn({ kind: 'codex', machineId: 'm1', sessionId: 's1', directory: '/repo', codexThreadId: 't1' }, options))
                .toEqual({ type: 'success', sessionId: 's2' });
            expect(machineRPC.mock.calls[0][2]).toMatchObject({ sourceSessionId: 's1', codexThreadId: 't1' });
            expect(machineRPC.mock.calls[1][2]).toMatchObject({ parentSessionId: 's1', resumeCodexThreadId: 't2', codexSessionGrant: 'a'.repeat(43) });
            expect(requests).toHaveLength(1);
        },
    );

    it('lists rewind points using the explicit source audit without acquiring credentials', async () => {
        machineRPC.mockResolvedValue({ type: 'success', points: [] });
        await codexListRewindPoints({ machineId: 'm1', directory: '/repo', sourceSessionId: 's1', codexThreadId: 't1' });
        expect(machineRPC.mock.calls[0][2]).toMatchObject({ sourceSessionId: 's1', codexThreadId: 't1' });
        expect(requests).toHaveLength(0);
    });

    it.each(['codex-account-unavailable', 'profile-not-found'])('blocks RPC on bound-account error %s and keeps safe machine/RPC context', async (error) => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error, auth: 'must-not-escape' }), { status: 409 }));
        for (const result of [
            await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex' }),
            await machineResumeSession({ machineId: 'm1', sessionId: 's1', agent: 'codex' }),
        ]) {
            expect(result).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('m1') });
            expect(JSON.stringify(result)).toContain('happy-session');
            expect(JSON.stringify(result)).not.toContain('must-not-escape');
        }
        expect(machineRPC).not.toHaveBeenCalled();
    });

    it('uses local machine Codex when no account is bound', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'codex-account-unbound' }), { status: 409 }));
        const result = await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex' });
        expect(result).toEqual({ type: 'success', sessionId: 'paws-new' });
        expect(machineRPC).toHaveBeenCalledWith('m1', 'spawn-happy-session', expect.not.objectContaining({ codexSessionGrant: expect.anything() }), expect.anything());
    });

    it('uses local machine Codex when the app is signed out', async () => {
        getCredentials.mockResolvedValue(null);
        expect(await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex' }))
            .toEqual({ type: 'success', sessionId: 'paws-new' });
        expect(requests).toHaveLength(0);
        expect(machineRPC).toHaveBeenCalledWith('m1', 'spawn-happy-session', expect.not.objectContaining({ codexSessionGrant: expect.anything() }), expect.anything());
    });

    it.each(['throw', 'envelope'])('redacts the one-time grant from %s RPC errors', async (mode) => {
        machineRPC.mockImplementation(async () => {
            const message = `RPC rejected grant ${'a'.repeat(43)}`;
            if (mode === 'throw') throw new Error(message);
            return { error: message };
        });
        const result = await machineSpawnNewSession({ machineId: 'm1', directory: '/repo', agent: 'codex' });
        expect(result).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('RPC rejected') });
        expect(JSON.stringify(result)).not.toContain('a'.repeat(43));
    });
});
