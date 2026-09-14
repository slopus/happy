import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, alert, confirm, push } = vi.hoisted(() => ({ machineRPC: vi.fn(), alert: vi.fn(), confirm: vi.fn(), push: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000002' }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC }, getHappyClientId: () => 'web' }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://test' }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => ({ token: 'bearer', secret: 'secret' }) } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('@/hooks/useSpawnSession', () => ({ configureSpawnedSession: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert, confirm } }));
vi.mock('expo-router', () => ({ router: { push } }));
vi.mock('@/text', async () => { const { en } = await import('@/text/_default'); return { t: (key: string) => key.startsWith('codexAccounts.')
    ? key.split('.').reduce((value: any, part) => value?.[part], en) : key }; });
vi.mock('./sessionStartupTrace', () => ({ traceStartup: vi.fn() }));
vi.mock('./sessionStartupTraceRuntime', () => ({ sessionStartupTraceRuntime: { begin: vi.fn(), bindSession: vi.fn() } }));

import { firstSubmission } from './firstSubmissionRuntime';
import { clearFirstSubmissionScope, setFirstSubmissionScope } from './firstSubmissionScope';

const input = { text: 'hello', prompt: 'hello', machineId: 'machine-1', path: '/repo',
    agent: 'codex' as const, worktreeKey: null, attachments: [] };
let saved: Map<string, string>;
beforeEach(() => {
    saved = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
    });
    machineRPC.mockReset(); alert.mockReset(); confirm.mockReset(); push.mockReset();
    confirm.mockResolvedValue(true);
    setFirstSubmissionScope('account/server', 'https://test');
});
afterEach(() => { clearFirstSubmissionScope(); vi.unstubAllGlobals(); });

describe('first submission launch errors', () => {
    it('surfaces an unavailable bound account through the actual owner/runtime/ops flow without persisting it', async () => {
        const error = 'codex-account-unavailable';
        const instruction = /paws codex account upload/i;
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error, auth: 'must-not-escape' }), { status: 409 }));

        expect(await firstSubmission.submit(input, { images: [] })).toBe(false);

        expect(firstSubmission.getSnapshot()).toMatchObject({ phase: 'failed', failure: 'spawn', text: 'hello' });
        expect(confirm).toHaveBeenCalledWith('common.error', expect.stringMatching(instruction), { cancelText: 'common.cancel', confirmText: 'Open Device Environment' });
        expect(confirm.mock.calls[0][1]).toContain('Device Environment');
        expect(confirm.mock.calls[0][1]).not.toContain('must-not-escape');
        expect(push).toHaveBeenCalledWith('/settings/device-environment');
        expect(alert).not.toHaveBeenCalled();
        expect(machineRPC).not.toHaveBeenCalled();
        expect([...saved.values()].join('')).not.toContain(error);
        expect([...saved.values()].join('')).not.toContain('must-not-escape');
        expect(JSON.stringify(firstSubmission.getSnapshot())).not.toContain(error);
    });

    it('ignores a recovery confirmation after its account scope changes', async () => {
        confirm.mockImplementation(async () => { setFirstSubmissionScope('new-account/server', 'https://test'); return true; });
        vi.stubGlobal('fetch', async () => Response.json({ error: 'codex-account-unavailable' }, { status: 409 }));
        expect(await firstSubmission.submit(input, { images: [] })).toBe(false);
        expect(confirm).toHaveBeenCalledOnce(); expect(push).not.toHaveBeenCalled();
    });

    it('shows the generic fallback for an empty launch error and never persists the grant', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ grant: 'a'.repeat(43),
            expiresAt: '2026-09-11T00:01:00Z', profile: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Work', credentialVersion: 1 } })));
        machineRPC.mockResolvedValue({ type: 'error', errorMessage: '' });

        expect(await firstSubmission.submit(input, { images: [] })).toBe(false);

        expect(alert).toHaveBeenCalledWith('common.error', 'newSession.submissionFailed');
        expect(confirm).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
        expect(firstSubmission.getSnapshot()).toMatchObject({ phase: 'failed', failure: 'spawn' });
        expect([...saved.values()].join('')).not.toContain('a'.repeat(43));
        expect(JSON.stringify(firstSubmission.getSnapshot())).not.toContain('a'.repeat(43));
    });

    it('does not show a late launch error after switching accounts', async () => {
        let resolve!: (response: Response) => void;
        vi.stubGlobal('fetch', () => new Promise<Response>((done) => { resolve = done; }));
        const submitted = firstSubmission.submit(input, { images: [] });
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        setFirstSubmissionScope('other-account/server', 'https://test');
        resolve(new Response(JSON.stringify({ error: 'codex-account-unbound' }), { status: 409 }));
        expect(await submitted).toBe(false);
        expect(alert).not.toHaveBeenCalled();
        expect(firstSubmission.getSnapshot()).toBeNull();
    });
});
