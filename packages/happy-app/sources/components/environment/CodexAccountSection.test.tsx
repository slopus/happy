import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer harness has no separate typings
import TestRenderer from 'react-test-renderer';
import type { CodexAccountProfile, ListCodexAccountsResponse } from '@/sync/apiCodexAccounts';

const mocks = vi.hoisted(() => ({
    credentials: { token: 'paws-test', secret: 'test-secret' }, server: 'https://test',
    copy: vi.fn(), prompt: vi.fn(), confirm: vi.fn(), rpc: vi.fn(), authReady: true,
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default } }));
vi.mock('react-native-unistyles', async () => { const { appThemes } = await import('@/themePacks'); return {
    StyleSheet: { hairlineWidth: 1, create: (f: any) => f(appThemes.ginghamDark) },
}; });
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: mocks.credentials }), getCurrentAuth: () => mocks.authReady ? { credentials: mocks.credentials } : null }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'web', apiSocket: { machineRPC: mocks.rpc } }));
vi.mock('@/modal', () => ({ Modal: { prompt: mocks.prompt, confirm: mocks.confirm } }));
vi.mock('@/text', async () => { const { en } = await import('@/text/_default'); return { t: (key: string, params: unknown) => {
    const value = key.split('.').reduce((v: any, part) => v?.[part], en); return typeof value === 'function' ? value(params) : value ?? key;
} }; });
import { useCodexAccounts } from '@/hooks/useCodexAccounts';
import { CodexAccountSection, CodexAccountBindingCell } from './CodexAccountSection';

const id = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const now = Date.parse('2026-09-11T10:00:00Z');
function profile(extra: Partial<CodexAccountProfile> = {}): CodexAccountProfile {
    return { id, displayName: 'Codex · A7F2', status: 'available', credentialVersion: 1,
        createdAt: '2026-09-11T09:00:00Z', updatedAt: '2026-09-11T09:00:00Z', lastValidatedAt: null,
        quota: { state: 'current', remainingPercent: 68.4, weeklyResetsAt: '2026-09-13T10:30:00Z', observedAt: '2026-09-11T09:00:00Z' }, ...extra };
}
const machines = [{ id: 'a', name: 'Laptop' }, { id: 'b', name: 'Offline Mac' }];
function Harness() {
    const controller = useCodexAccounts();
    React.useEffect(() => { mocks.authReady = true; }, []);
    return <><CodexAccountSection controller={controller} machines={machines} />
        {machines.map(machine => <CodexAccountBindingCell key={machine.id} controller={controller} machine={machine} width={208} />)}</>;
}
const textOf = (node: any): string => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(textOf).join(' ');
describe('Codex account UI with real metadata API and controller', () => {
    let renderer: any;
    let data: ListCodexAccountsResponse;
    let requests: { url: string; method: string; body: any }[];
    let fail: string | null;
    beforeEach(() => {
        vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.server = 'https://test'; mocks.authReady = true; mocks.copy.mockResolvedValue(true);
        data = { profiles: [profile(), profile({ id: secondId, displayName: 'Work' })],
            bindings: [{ machineId: 'a', profileId: id, version: 3 }, { machineId: 'b', profileId: null, version: 8 }], migration: 'none' };
        requests = []; fail = null;
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            const method = init.method!; const body = init.body ? JSON.parse(init.body as string) : undefined;
            requests.push({ url, method, body });
            if (method === 'GET') return Response.json(data);
            if (fail) return Response.json({ error: fail }, { status: 409 });
            if (method === 'POST') return Response.json({ grant: 'a'.repeat(43), expiresAt: '2026-09-11T10:01:00.000Z', profile: { id, displayName: 'Codex · A7F2', credentialVersion: 1 } });
            if (method === 'PATCH') { data.profiles[0].displayName = body.displayName; return Response.json({ profile: data.profiles[0] }); }
            if (method === 'DELETE') { data.profiles = data.profiles.filter(p => p.id !== id); data.bindings[0] = { machineId: 'a', profileId: null, version: 4 }; return Response.json({ success: true }); }
            const machineId = url.split('/').at(-2)!;
            const binding = { machineId, profileId: body.profileId, version: body.expectedVersion + 1 };
            data.bindings = data.bindings.map(b => b.machineId === machineId ? binding : b);
            return Response.json({ binding });
        });
    });
    afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
    async function render() { await act(async () => { renderer = TestRenderer.create(<Harness />); }); }
    async function press(testID: string) { await act(async () => { await renderer.root.findByProps({ testID }).props.onPress(); }); }
    const card = () => renderer.root.findByProps({ testID: `codex-account-${id}` });
    it('shows metadata and local reset time; copies the exact no-argument command with transient feedback', async () => {
        await render();
        expect(textOf(card())).toContain('Codex · A7F2'); expect(textOf(card())).toContain('68%');
        expect(textOf(card())).toContain(new Date('2026-09-13T10:30:00Z').toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
        expect(textOf(card())).toContain('Updated'); expect(textOf(card())).toContain('Available');
        expect(textOf(renderer.toJSON())).toContain('paws codex account upload');
        await press('codex-account-copy'); expect(mocks.copy).toHaveBeenCalledWith('paws codex account upload');
        expect(textOf(renderer.root.findByProps({ testID: 'codex-account-copy' }))).toContain('Copied');
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(textOf(renderer.root.findByProps({ testID: 'codex-account-copy' }))).not.toContain('Copied');
        expect(mocks.confirm).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
    });
    it('refreshes only through an explicitly confirmed opaque grant on the account-bound device', async () => {
        mocks.confirm.mockResolvedValue(true); mocks.rpc.mockResolvedValue({ type: 'success', accepted: true }); await render();
        await press(`codex-account-refresh-${id}`);
        expect(mocks.confirm).toHaveBeenCalledWith('Refresh Codex quota?', expect.stringContaining('small amount'), expect.objectContaining({ confirmText: 'Refresh quota' }));
        expect(requests.filter(request => request.method === 'POST')).toEqual([{ url: 'https://test/v1/codex-session-grants', method: 'POST', body: { machineId: 'a' } }]);
        expect(mocks.rpc).toHaveBeenCalledWith('a', 'refresh-codex-account-quota', { grant: 'a'.repeat(43) }, expect.objectContaining({ timeoutMs: 60_000 }));
    });
    it.each([
        ['unknown', null, null, null, '7d quota unknown', false],
        ['stale', 68, '2026-09-13T10:30:00Z', '2026-09-10T08:00:00Z', 'May be outdated', true],
        ['reset', 68, '2026-09-11T08:00:00Z', '2026-09-10T08:00:00Z', 'Waiting for the next Paws session', false],
        ['current', 68, '2026-09-11T08:00:00Z', '2026-09-10T08:00:00Z', 'Waiting for the next Paws session', false],
    ] as const)('renders %s without inventing current quota', async (state, remainingPercent, weeklyResetsAt, observedAt, label, showPercent) => {
        data.profiles = [profile({ quota: { state, remainingPercent, weeklyResetsAt, observedAt } })]; await render();
        expect(textOf(card())).toContain(label); expect(textOf(card()).includes('68%')).toBe(showPercent);
    });
    it('prioritizes invalid status while retaining the last quota and makes unavailable options unselectable', async () => {
        data.profiles[0].status = 'invalid'; await render();
        expect(textOf(card())).toContain('Account invalid'); expect(textOf(card())).toContain('68%');
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-a' }))).toContain('Account invalid');
        await press('codex-binding-b');
        expect(renderer.root.findByProps({ testID: `codex-binding-option-b-${id}` }).props.disabled).toBe(true);
    });
    it('shows needs-refresh, migration recovery, missing profile and missing binding distinctly', async () => {
        data.profiles[0].status = 'needs-refresh'; data.migration = 'needs-upload';
        data.bindings[0].profileId = '00000000-0000-4000-8000-000000000009'; data.bindings.pop(); await render();
        expect(textOf(card())).toContain('Needs update'); expect(textOf(renderer.toJSON())).toContain('Upload your Codex login again');
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-a' }))).toContain('Account removed');
        expect(renderer.root.findByProps({ testID: 'codex-binding-b' }).props.disabled).toBe(true);
    });
    it('edits only the offline device with the displayed binding version, then permits explicit unbind', async () => {
        await render(); await press('codex-binding-b'); await press(`codex-binding-option-b-${secondId}`);
        expect(requests.filter(r => r.method === 'PUT')).toEqual([{ url: 'https://test/v1/machines/b/codex-account', method: 'PUT', body: { profileId: secondId, expectedVersion: 8 } }]);
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-a' }))).toContain('Codex · A7F2');
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-b' }))).toContain('Work');
        await press('codex-binding-b'); await press('codex-binding-option-b-unbound');
        expect(requests.at(-1)?.body).toEqual({ profileId: null, expectedVersion: 9 });
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-b' }))).toContain('Unbound');
        expect(requests.filter(r => r.method === 'GET')).toHaveLength(1);
    });
    it('refreshes metadata on a version conflict and shows an actionable error without silently retrying', async () => {
        await render(); fail = 'binding-version-conflict'; data.bindings[1] = { machineId: 'b', profileId: id, version: 12 };
        await press('codex-binding-b'); await press(`codex-binding-option-b-${secondId}`);
        expect(textOf(renderer.toJSON())).toContain('Binding changed');
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-b' }))).toContain('Codex · A7F2');
        expect(requests.map(r => r.method)).toEqual(['GET', 'PUT', 'GET']);
    });
    it('renames only after the prompt is accepted and rejects an empty name', async () => {
        await render(); mocks.prompt.mockResolvedValueOnce(null).mockResolvedValueOnce(' ').mockResolvedValueOnce(' Personal ');
        await press(`codex-account-rename-${id}`); await press(`codex-account-rename-${id}`);
        expect(requests).toHaveLength(1); await press(`codex-account-rename-${id}`);
        expect(mocks.prompt).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ defaultValue: 'Codex · A7F2' }));
        expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { displayName: 'Personal' } });
        expect(textOf(card())).toContain('Personal');
    });
    it('confirms affected device names before deletion and refreshes cleared bindings', async () => {
        await render(); mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await press(`codex-account-delete-${id}`); expect(requests).toHaveLength(1);
        await press(`codex-account-delete-${id}`);
        expect(mocks.confirm).toHaveBeenLastCalledWith(expect.any(String), expect.stringContaining('Laptop'), expect.objectContaining({ destructive: true }));
        expect(renderer.root.findAllByProps({ testID: `codex-account-${id}` })).toHaveLength(0);
        expect(textOf(renderer.root.findByProps({ testID: 'codex-binding-a' }))).toContain('Unbound');
    });
    it('contains long labels and uses semantic normal, pressed and selected surfaces', async () => {
        data.profiles[0].displayName = 'Long account '.repeat(6); await render();
        const { appThemes } = await import('@/themePacks'); const colors = appThemes.ginghamDark.colors;
        expect(renderer.root.findByProps({ testID: 'codex-account-cards' }).props.style).toMatchObject({ flexWrap: 'wrap', minWidth: 0 });
        expect(card().props.style).toMatchObject({ maxWidth: '100%', minWidth: 0, backgroundColor: colors.surface });
        const button = renderer.root.findByProps({ testID: 'codex-binding-b' }).findByType('Pressable');
        expect(Object.assign({}, ...button.props.style({ pressed: true })).backgroundColor).toBe(colors.surfacePressed);
        await press('codex-binding-a');
        const selected = renderer.root.findByProps({ testID: `codex-binding-option-a-${id}` }).findByType('Pressable');
        expect(selected.props.accessibilityState.checked).toBe(true);
        expect(Object.assign({}, ...selected.props.style({ pressed: false })).backgroundColor).toBe(colors.surfaceSelected);
    });
    it('advances stale and reset display at local time boundaries without network polling', async () => {
        data.profiles[0].quota.observedAt = '2026-09-10T10:00:01Z'; data.profiles[0].quota.weeklyResetsAt = '2026-09-11T10:00:03Z';
        await render(); await act(async () => { vi.advanceTimersByTime(1100); });
        expect(textOf(card())).toContain('May be outdated');
        await act(async () => { vi.advanceTimersByTime(2100); });
        expect(textOf(card())).toContain('Waiting for the next Paws session'); expect(textOf(card())).not.toContain('68%');
        expect(requests).toHaveLength(1);
    });
    it('reports clipboard failure inline and renders a useful empty state', async () => {
        data.profiles = []; await render(); mocks.copy.mockRejectedValueOnce(new Error('clipboard unavailable'));
        await press('codex-account-copy'); expect(textOf(renderer.toJSON())).toContain('Copy failed');
        expect(textOf(renderer.toJSON())).toContain('Upload a Codex login');
    });
    it('loads when the parent publishes initial authentication after child effects', async () => {
        mocks.authReady = false; await render(); expect(textOf(card())).toContain('Codex · A7F2');
    });
    it('deduplicates StrictMode initial reads so a replay cannot overwrite a later rename', async () => {
        await act(async () => { renderer = TestRenderer.create(<React.StrictMode><Harness /></React.StrictMode>); });
        expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
        mocks.prompt.mockResolvedValue('Newest name'); await press(`codex-account-rename-${id}`);
        expect(textOf(card())).toContain('Newest name');
        expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
    });
    it('rejects an old scope response that arrives after the new scope metadata', async () => {
        const complete: ((response: Response) => void)[] = [];
        vi.stubGlobal('fetch', () => new Promise<Response>(resolve => complete.push(resolve)));
        await render();
        mocks.server = 'https://other';
        await act(async () => { renderer.update(<Harness />); });
        await act(async () => { complete[1](Response.json({ ...data, profiles: [profile({ displayName: 'New scope' })] })); });
        await act(async () => { complete[0](Response.json(data)); });
        expect(textOf(card())).toContain('New scope'); expect(textOf(card())).not.toContain('Codex · A7F2');
    });
    it('does not apply a confirmation from an old server scope', async () => {
        await render(); mocks.prompt.mockImplementation(async () => { mocks.server = 'https://other'; return 'Changed'; });
        await press(`codex-account-rename-${id}`); expect(requests).toHaveLength(1);
    });
    it('shows rename conflict without changing the existing label', async () => {
        await render(); fail = 'display-name-conflict'; mocks.prompt.mockResolvedValue('Work');
        await press(`codex-account-rename-${id}`);
        expect(textOf(card())).toContain('Codex · A7F2'); expect(textOf(renderer.toJSON())).toContain('name is already in use');
    });
    it('disables binding edits when conflict recovery cannot obtain current versions', async () => {
        await render(); vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            if (init.method === 'GET') throw new Error('network');
            return Response.json({ error: 'binding-version-conflict' }, { status: 409 });
        });
        await press('codex-binding-b'); await press(`codex-binding-option-b-${secondId}`);
        expect(renderer.root.findByProps({ testID: 'codex-binding-b' }).props.disabled).toBe(true);
        expect(textOf(renderer.toJSON())).toContain('Binding changed');
    });
});
