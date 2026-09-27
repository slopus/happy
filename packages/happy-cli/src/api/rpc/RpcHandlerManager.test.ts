/**
 * aplus-dev-studio specs/managed-cloud-byos §5.12 (1).
 *
 * The generic manager turns every thrown error into `{ error: message }`, so a
 * `ManagedRpcError.code` is lost on the wire. The fix must not teach this class
 * about managed types — the managed registration wrapper normalizes its own
 * errors instead. These tests exercise the **real** `handleRequest`, including
 * the encryption round trip, so a fix that only changes an in-memory shape does
 * not pass.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { RpcHandlerManager } from './RpcHandlerManager';
import { decodeBase64, encodeBase64, decrypt, encrypt } from '@/api/encryption';
import { ManagedRpcError, registerManagedRpcHandlers } from '@/daemon/managedRpcHandlers';

const KEY = new Uint8Array(randomBytes(32));

function makeManager(): RpcHandlerManager {
    return new RpcHandlerManager({
        scopePrefix: 'machine-1',
        encryptionKey: KEY,
        encryptionVariant: 'legacy',
        logger: () => {},
    });
}

async function call(manager: RpcHandlerManager, method: string, params: unknown) {
    const response = await manager.handleRequest({
        method: `machine-1:${method}`,
        params: encodeBase64(encrypt(KEY, 'legacy', params as object)),
    } as never);
    return decrypt(KEY, 'legacy', decodeBase64(response as string)) as Record<string, unknown>;
}

/** Only the four managed methods are wired; the rest throw for BYOS-shape tests. */
function managedHandlersThrowing(error: unknown) {
    const reject = async () => { throw error; };
    return {
        spawn: reject, stop: reject, receipt: reject, lease: reject,
    } as never;
}

describe('managed refusal codes survive the encrypted round trip', () => {
    it.each([
        ['token-expired'],
        ['stale-epoch'],
        ['fence-incomplete'],
        ['stopped-before-dispatch'],
        ['token-wrong-project'],
        ['token-unknown-key'],
    ])('preserves %s as a machine-readable code', async (code) => {
        const manager = makeManager();
        registerManagedRpcHandlers(manager, managedHandlersThrowing(new ManagedRpcError(code)));

        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe(code);
    });

    it('never puts the ManagedRpcError detail on the wire', async () => {
        const manager = makeManager();
        registerManagedRpcHandlers(
            manager,
            managedHandlersThrowing(new ManagedRpcError('spawn-rejected', 'sk-live-SECRET-detail')),
        );

        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe('spawn-rejected');
        // `message` is `code: detail`; shipping it verbatim leaks the detail.
        expect(JSON.stringify(body)).not.toContain('sk-live-SECRET-detail');
        expect(typeof body.error).toBe('string');
    });

    it('carries a bounded launch diagnostic alongside the code', async () => {
        /*
         * `spawn-rejected` alone covers both "the envelope was wrong" and "the
         * launch itself refused", and the parent cannot act on the difference.
         * One enum member — reviewed here, not composed at the throw site —
         * separates them without putting a message on the wire.
         */
        const manager = makeManager();
        registerManagedRpcHandlers(
            manager,
            managedHandlersThrowing(
                new ManagedRpcError('spawn-rejected', 'launch-refused:no-volume', 'launch-refused'),
            ),
        );
        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe('spawn-rejected');
        expect(body.diagnostic).toBe('launch-refused');
        // The detail behind it is still not a wire field.
        expect(JSON.stringify(body)).not.toContain('no-volume');
    });

    it('drops a diagnostic that is not one of the reviewed members', async () => {
        const manager = makeManager();
        registerManagedRpcHandlers(
            manager,
            managedHandlersThrowing(
                new ManagedRpcError('spawn-rejected', 'detail', 'sk-live-INVENTED'),
            ),
        );
        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe('spawn-rejected');
        expect(body.diagnostic).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain('sk-live-INVENTED');
    });

    it('reports an unrecognised refusal code as unknown, never as a real refusal', async () => {
        const manager = makeManager();
        registerManagedRpcHandlers(
            manager,
            managedHandlersThrowing(new ManagedRpcError('not-a-known-refusal')),
        );

        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe('managed-unknown-failure');
        expect(JSON.stringify(body)).not.toContain('not-a-known-refusal');
    });

    it('never puts an unexpected error onto the wire or into the log', async () => {
        const logged: unknown[] = [];
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: KEY,
            encryptionVariant: 'legacy',
            logger: (msg, data) => { logged.push(msg, data); },
        });
        // An unexpected exception is exactly where a provider URL or a token
        // shows up; rethrowing would publish it in both places.
        registerManagedRpcHandlers(
            manager,
            managedHandlersThrowing(
                new TypeError('GET https://api.example/v1?key=SENTINEL-SECRET failed'),
            ),
        );

        const body = await call(manager, 'managed:spawn', {});
        expect(body.code).toBe('managed-unknown-failure');
        expect(JSON.stringify(body)).not.toContain('SENTINEL-SECRET');
        expect(JSON.stringify(logged)).not.toContain('SENTINEL-SECRET');
    });

    it('normalises a synchronous throw the same way', async () => {
        const manager = makeManager();
        registerManagedRpcHandlers(manager, {
            spawn: () => { throw new ManagedRpcError('stale-epoch'); },
            stop: async () => ({}), receipt: async () => ({}), lease: async () => ({}),
        } as never);

        expect((await call(manager, 'managed:spawn', {})).code).toBe('stale-epoch');
    });

    it('passes a successful managed result through unchanged', async () => {
        const manager = makeManager();
        registerManagedRpcHandlers(manager, {
            spawn: async () => ({ accepted: true, terminationProven: false }),
            stop: async () => ({}), receipt: async () => ({}), lease: async () => ({}),
        } as never);

        const body = await call(manager, 'managed:spawn', {});
        expect(body).toMatchObject({ accepted: true, terminationProven: false });
        expect(body.code).toBeUndefined();
    });
});

describe('BYOS behaviour is unchanged', () => {
    it('still reports a thrown error as { error: message } with no code', async () => {
        const manager = makeManager();
        manager.registerHandler('bash', async () => { throw new Error('generic failure'); });

        const body = await call(manager, 'bash', { command: 'ls' });
        expect(body).toEqual({ error: 'generic failure' });
    });

    it('still returns plain results for non-managed handlers', async () => {
        const manager = makeManager();
        manager.registerHandler('bash', async () => ({ stdout: 'ok' }));

        expect(await call(manager, 'bash', {})).toEqual({ stdout: 'ok' });
    });

    it('still reports Method not found unchanged', async () => {
        const manager = makeManager();
        expect(await call(manager, 'nope', {})).toEqual({ error: 'Method not found' });
    });
});

describe('native probe RPC diagnostics', () => {
    const rpcLatency = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111' };
    it.each(['legacy', 'dataKey'] as const)('preserves %s encrypted results while returning bounded timing', async (variant) => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: variant, logger: () => {} });
        let calls = 0;
        manager.registerHandler('daemon-session-state', async () => { calls++; return { version: 1, state: 'present' }; });
        const response = await manager.handleRequest({ method: 'machine-1:daemon-session-state', params: encodeBase64(encrypt(KEY, variant, { sessionId: 'private-session' })), rpcLatency });
        expect(calls).toBe(1);
        expect(decrypt(KEY, variant, decodeBase64(response.result))).toEqual({ version: 1, state: 'present' });
        expect(response.rpcLatency.id).toBe(rpcLatency.id);
        expect(response.rpcLatency.spans.map((s: any) => s.stage)).toEqual(['daemon-total', 'daemon-decrypt', 'daemon-handler', 'daemon-encrypt']);
        expect(JSON.stringify(response.rpcLatency)).not.toMatch(/private-session|machine-1|params|result/);
    });
    it('does not wrap other RPC methods and preserves managed refusal without dispatch', async () => {
        const manager = makeManager();
        manager.registerHandler('echo', async () => 'ok');
        const params = encodeBase64(encrypt(KEY, 'legacy', {}));
        expect(typeof await manager.handleRequest({ method: 'machine-1:echo', params, rpcLatency })).toBe('string');
        let called = false;
        manager.registerHandler('daemon-session-state', async () => { called = true; });
        manager.setManagedAllowlist(['spawn']);
        const response = await manager.handleRequest({ method: 'machine-1:daemon-session-state', params, rpcLatency });
        expect(called).toBe(false);
        expect(decrypt(KEY, 'legacy', decodeBase64(response.result))).toMatchObject({ code: 'MANAGED_CAPABILITY_REQUIRED' });
        expect(response.rpcLatency.spans.map((s: any) => s.stage)).toEqual(['daemon-total']);
    });
});

it('preserves the encrypted error response for a malformed untraced request', async () => {
    const manager = makeManager();
    const response = await manager.handleRequest(null as never);
    expect(decrypt(KEY, 'legacy', decodeBase64(response))).toHaveProperty('error');
});

it('enforces a separate internal method policy before dispatch including later registrations', async () => {
    const manager = makeManager(); let invoked = 0;
    manager.setMethodPolicy(method => method === 'read-safe' ? null : { error: 'Trial method unavailable', code: 'TRIAL_UNAVAILABLE' });
    manager.registerHandler('read-safe', async () => ({ read: true }));
    manager.registerHandler('later-spawn', async () => { invoked++; return {}; });
    expect(await call(manager, 'read-safe', {})).toEqual({ read: true });
    expect(await call(manager, 'later-spawn', {})).toEqual({ error: 'Trial method unavailable', code: 'TRIAL_UNAVAILABLE' });
    expect(await call(manager, 'unknown-later-method', {})).toMatchObject({ code: 'TRIAL_UNAVAILABLE' });
    expect(invoked).toBe(0);
});
