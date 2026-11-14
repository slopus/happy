import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { BotsFrame } from './BotsFrame.web';

describe('Bots iframe identity boundary', () => {
    let tree: any, listener: ((event: any) => void) | undefined;
    const child = { postMessage: vi.fn() }, authenticated = vi.fn(), failure = vi.fn();
    const origin = 'https://bots.example';
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks(); listener = undefined;
        vi.stubGlobal('window', {
            addEventListener: (_type: string, callback: any) => { listener = callback; },
            removeEventListener: (_type: string, callback: any) => { if (listener === callback) listener = undefined; },
        });
    });
    afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });
    const mount = async (expiresAt = Date.now() + 60_000) => {
        await act(async () => { tree = TestRenderer.create(<BotsFrame runtimeUrl={origin + '/'} ticket={'s'.repeat(43)} expiresAt={expiresAt} onAuthenticated={authenticated} onFailure={failure} />, { createNodeMock: () => ({ contentWindow: child }) }); });
    };
    it('sends the ticket once to the exact frame origin, without putting it in its URL or attributes', async () => {
        await mount(); const frame = tree.root.findByType('iframe');
        expect(frame.props.src).toBe(origin + '/');
        expect(JSON.stringify(frame.props)).not.toContain('s'.repeat(43));
        await act(async () => { listener?.({ origin, source: child, data: { type: 'paws:rakazo:ready' } }); frame.props.onLoad(); });
        expect(child.postMessage).toHaveBeenCalledTimes(1);
        expect(child.postMessage).toHaveBeenCalledWith({ type: 'paws:rakazo:launch', ticket: 's'.repeat(43) }, origin);
    });
    it('ignores both a wrong origin and a same-origin message from a different window', async () => {
        await mount();
        await act(async () => {
            listener?.({ origin: 'https://other.example', source: child, data: { type: 'paws:rakazo:authenticated' } });
            listener?.({ origin, source: {}, data: { type: 'paws:rakazo:error' } });
        });
        expect(authenticated).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
        await act(async () => listener?.({ origin, source: child, data: { type: 'paws:rakazo:authenticated' } }));
        expect(authenticated).toHaveBeenCalledTimes(1);
    });
    it('does not post an expired ticket, and removes the message listener on exit', async () => {
        await mount(Date.now() - 1);
        await act(async () => tree.root.findByType('iframe').props.onLoad());
        expect(child.postMessage).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledTimes(1);
        await act(async () => tree.unmount()); tree = null; expect(listener).toBeUndefined();
    });
});
