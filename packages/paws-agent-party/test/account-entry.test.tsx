// @vitest-environment jsdom
import React, { useContext } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountContext } from '../src/web/AccountContext.js';
vi.mock('../src/web/GroupChatApp.js', () => ({ GroupChatApp: () => { const account = useContext(AccountContext); return <button onClick={account?.logout}>Logged in {account?.accountId}</button>; } }));
import { AccountEntry } from '../src/web/AccountEntry.js';
afterEach(() => { cleanup(); sessionStorage.clear(); history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });
it('exchanges a ticket, restores after refresh, and revokes on explicit logout', async () => {
    history.replaceState(null, '', '/#ticket=once');
    const fetcher = vi.fn(async (url: string) => {
        if (url.endsWith('/config')) return Response.json({ accountMode: true });
        if (url.endsWith('/exchange')) return Response.json({ token: 'scoped-only' });
        if (url.endsWith('/account')) return Response.json({ account: { id: 'A' }, serverUrl: 'https://47.115.228.20:8443' });
        return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountEntry/>);
    await screen.findByRole('button', { name: 'Logged in A' });
    expect(location.hash).toBe(''); expect(sessionStorage.getItem('party-account-session')).toBe('scoped-only');
    view.unmount(); render(<AccountEntry/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Logged in A' }));
    expect(sessionStorage.getItem('party-account-session')).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/exchange'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/logout'))).toHaveLength(1);
    expect(screen.getByRole('link', { name: '使用 Paws 继续 →' }).getAttribute('href')).toContain('/agent-party-access');
});
it('never falls back to the old account if a new ticket is rejected', async () => {
    sessionStorage.setItem('party-account-session', 'old-account'); history.replaceState(null, '', '/#ticket=expired');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/config') ? Response.json({ accountMode: true }) : Response.json({ error: 'expired' }, { status: 401 })));
    render(<AccountEntry/>); await screen.findByRole('alert');
    expect(sessionStorage.getItem('party-account-session')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
});
