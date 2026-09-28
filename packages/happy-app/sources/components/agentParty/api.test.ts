import { afterEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ current: true, server: 'https://47.115.228.20:8443' }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => runtime.current, canonicalAccountServer: (url: string) => new URL(url).origin }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => runtime.server }));
import { connectAgentCatalog, PARTY_ORIGIN } from './api';
afterEach(() => { vi.unstubAllGlobals(); runtime.current = true; runtime.server = 'https://47.115.228.20:8443'; });
it('uses same-origin AgentParty on the independent staging site', async () => {
    runtime.server = 'https://47.115.228.20:8444';
    const fetcher = vi.fn(async (url: string) => {
        expect(url).toBe('https://47.115.228.20:8444/agent-party/api/access/ticket');
        return Response.json({ ticket: 'a'.repeat(43) });
    });
    vi.stubGlobal('fetch', fetcher);
    const { issuePartyTicket } = await import('./api');
    await expect(issuePartyTicket({ token: 'token', secret: 'secret' }, new AbortController().signal)).resolves.toBe('a'.repeat(43));
    expect(fetcher).toHaveBeenCalledOnce();
});
it('renews expired sessions once and preserves profile mutation, including native gateway Origin', async () => {
    let exchange = 0;
    const writes: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get('Origin')).toBe(PARTY_ORIGIN);
        if (url.endsWith('/ticket')) return Response.json({ ticket: 'a'.repeat(43) });
        if (url.endsWith('/exchange')) return Response.json({ token: `scoped-${++exchange}` });
        if (url.endsWith('/logout')) return Response.json({ ok: true });
        if (new Headers(init.headers).get('authorization') === 'Bearer scoped-1') return Response.json({ error: 'expired' }, { status: 401 });
        writes.push(init.body as string); return Response.json({ id: 'saved' });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = await connectAgentCatalog({ token: 'paws-token', secret: 'private-secret' }, new AbortController().signal);
    expect(await client.request('group-chat/agents/agent-1', { method: 'PATCH', body: '{"name":"saved draft"}' })).toEqual({ id: 'saved' });
    expect(exchange).toBe(2); expect(writes).toEqual(['{"name":"saved draft"}']);
    client.close();
    expect(fetcher.mock.calls.every(([url]) => !url.includes('private-secret') && !url.includes('paws-token'))).toBe(true);
});
it('rejects a late response after account switching before issuing a ticket to the UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { runtime.current = false; return Response.json({ ticket: 'a'.repeat(43) }); }));
    await expect(connectAgentCatalog({ token: 'a', secret: 'b' }, new AbortController().signal)).rejects.toThrow('取消');
});
it('can close an existing catalog during an account-server switch', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/ticket')
        ? Response.json({ ticket: 'a'.repeat(43) })
        : Response.json({ token: 'scoped' }));
    vi.stubGlobal('fetch', fetcher);
    const client = await connectAgentCatalog({ token: 'token', secret: 'secret' }, new AbortController().signal);
    runtime.server = 'https://example.invalid';
    expect(() => client.close()).not.toThrow();
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://47.115.228.20:8443/agent-party/api/access/logout');
});
