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
import { bindRpcRequest } from '@slopus/happy-wire';

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
        // Params are opened before any refusal, so a bound request gets a bound refusal (R18).
        expect(response.rpcLatency.spans.map((s: any) => s.stage)).toEqual(['daemon-total', 'daemon-decrypt']);
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

// The scope key is the only thing that authenticates a caller. A request it
// cannot open must not reach a handler — not even one that ignores its params,
// such as stop-daemon, which anyone able to route an rpc-request could
// otherwise trigger without holding any key.
describe('requests the scope key cannot open', () => {
    it.each(['legacy', 'dataKey'] as const)('never reach a handler (%s)', async (variant) => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: variant, logger: () => {} });
        let calls = 0;
        manager.registerHandler('stop-daemon', () => { calls++; return { message: 'stopping' }; });
        const foreignKey = encodeBase64(encrypt(new Uint8Array(randomBytes(32)), variant, {}));
        const randomBytesParams = encodeBase64(new Uint8Array(randomBytes(48)));
        for (const params of [foreignKey, randomBytesParams]) {
            const response = await manager.handleRequest({ method: 'machine-1:stop-daemon', params } as never);
            expect(decrypt(KEY, variant, decodeBase64(response as string))).toMatchObject({ code: 'RPC_DECRYPT_FAILED' });
        }
        expect(calls).toBe(0);
    });

    it.each(['legacy', 'dataKey'] as const)('still run a parameterless call sealed with the scope key (%s)', async (variant) => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: variant, logger: () => {} });
        const received: unknown[] = [];
        manager.registerHandler('stop-daemon', (params: unknown) => { received.push(params); return { message: 'stopping' }; });
        const response = await manager.handleRequest({
            method: 'machine-1:stop-daemon',
            params: encodeBase64(encrypt(KEY, variant, undefined)),
        } as never);
        expect(decrypt(KEY, variant, decodeBase64(response as string))).toEqual({ message: 'stopping' });
        expect(received).toEqual([null]);
    });

    it('never reach a handler on the traced path either', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: 'dataKey', logger: () => {} });
        let calls = 0;
        manager.registerHandler('daemon-session-state', async () => { calls++; return { version: 1, state: 'present' }; });
        const response = await manager.handleRequest({
            method: 'machine-1:daemon-session-state',
            params: encodeBase64(encrypt(new Uint8Array(randomBytes(32)), 'dataKey', { sessionId: 's' })),
            rpcLatency: { version: 1, id: '22222222-2222-4222-8222-222222222222' },
        } as never);
        expect(calls).toBe(0);
        expect(decrypt(KEY, 'dataKey', decodeBase64(response.result))).toMatchObject({ code: 'RPC_DECRYPT_FAILED' });
    });
});

// aplus-dev-studio specs/e2ee-machine-control-boundary R2/R3 — the key a
// request opens with decides its lane. The machine key (customer lane) reaches
// every handler; the server's own key reaches only the server-lane allowlist,
// and its answers are sealed with that key.
describe('server lane', () => {
    const SERVER_KEY = new Uint8Array(randomBytes(32));
    const makeLaned = () => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: KEY,
            encryptionVariant: 'dataKey',
            logger: () => {},
            serverLane: { encryptionKey: SERVER_KEY, allows: (method) => method === 'daemon-session-state' },
        });
        const calls: string[] = [];
        manager.registerHandler('daemon-session-state', async () => { calls.push('state'); return { state: 'present' }; });
        manager.registerHandler('bash', async () => { calls.push('bash'); return { stdout: 'secret' }; });
        manager.registerHandler('explodes', async () => { throw new Error('boom'); });
        return { manager, calls };
    };
    const send = (manager: RpcHandlerManager, method: string, key: Uint8Array) => manager.handleRequest({
        method: `machine-1:${method}`,
        params: encodeBase64(encrypt(key, 'dataKey', {})),
    } as never);

    it('runs an allowed method for the server key and answers with that key', async () => {
        const { manager, calls } = makeLaned();
        const response = await send(manager, 'daemon-session-state', SERVER_KEY);
        expect(decrypt(SERVER_KEY, 'dataKey', decodeBase64(response))).toEqual({ state: 'present' });
        expect(decrypt(KEY, 'dataKey', decodeBase64(response))).toBeNull();
        expect(calls).toEqual(['state']);
    });

    it('refuses any other method for the server key without running it', async () => {
        const { manager, calls } = makeLaned();
        const response = await send(manager, 'bash', SERVER_KEY);
        expect(decrypt(SERVER_KEY, 'dataKey', decodeBase64(response))).toMatchObject({ code: 'SERVER_LANE_METHOD_NOT_ALLOWED' });
        expect(calls).toEqual([]);
    });

    it('still runs every method for the machine key', async () => {
        const { manager, calls } = makeLaned();
        const response = await send(manager, 'bash', KEY);
        expect(decrypt(KEY, 'dataKey', decodeBase64(response))).toEqual({ stdout: 'secret' });
        expect(calls).toEqual(['bash']);
    });

    it('seals a server-lane handler error with the server key', async () => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: 'dataKey', logger: () => {},
            serverLane: { encryptionKey: SERVER_KEY, allows: () => true },
        });
        manager.registerHandler('explodes', async () => { throw new Error('boom'); });
        const response = await send(manager, 'explodes', SERVER_KEY);
        expect(decrypt(SERVER_KEY, 'dataKey', decodeBase64(response))).toEqual({ error: 'boom' });
    });

    it('answers a traced server-lane call with the server key', async () => {
        const { manager } = makeLaned();
        const response = await manager.handleRequest({
            method: 'machine-1:daemon-session-state',
            params: encodeBase64(encrypt(SERVER_KEY, 'dataKey', {})),
            rpcLatency: { version: 1, id: '33333333-3333-4333-8333-333333333333' },
        } as never);
        expect(decrypt(SERVER_KEY, 'dataKey', decodeBase64(response.result))).toEqual({ state: 'present' });
    });

    it('treats the server key as no key at all when the manager has no server lane', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: 'dataKey', logger: () => {} });
        let called = false;
        manager.registerHandler('daemon-session-state', async () => { called = true; return {}; });
        const response = await send(manager, 'daemon-session-state', SERVER_KEY);
        expect(decrypt(KEY, 'dataKey', decodeBase64(response))).toMatchObject({ code: 'RPC_DECRYPT_FAILED' });
        expect(called).toBe(false);
    });
});

// aplus-dev-studio specs/e2ee-machine-control-boundary R18/R19 — a customer-lane request
// names its method, scope, issue time and nonce inside the ciphertext, and the reply
// names the nonce. The server routes the method in clear and cannot change what is sealed.
describe('bound customer-lane requests', () => {
    const nonce = (fill: number) => Buffer.alloc(16, fill).toString('base64');
    const bound = (method: string, params: unknown, options: { nonce?: string; issuedAt?: number; scope?: string } = {}) => bindRpcRequest({
        method, scope: options.scope ?? 'machine-1', params, issuedAt: options.issuedAt ?? Date.now(), nonce: options.nonce ?? nonce(1),
    });
    const makeBound = (
        requireBoundRequests = false,
        serverLane?: { encryptionKey: Uint8Array; allows: (method: string) => boolean },
        maxBoundRequestsInWindow?: number,
    ) => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: 'dataKey', logger: () => {}, requireBoundRequests,
            ...(serverLane ? { serverLane } : {}),
            ...(maxBoundRequestsInWindow ? { maxBoundRequestsInWindow } : {}),
        });
        const calls: Array<[string, unknown]> = [];
        manager.registerHandler('readFile', async (params: unknown) => { calls.push(['readFile', params]); return { content: 'x' }; });
        manager.registerHandler('deleteFile', async (params: unknown) => { calls.push(['deleteFile', params]); return { success: true }; });
        manager.registerHandler('stop-daemon', (params: unknown) => { calls.push(['stop-daemon', params]); return { message: 'stopping' }; });
        return { manager, calls };
    };
    const send = async (manager: RpcHandlerManager, method: string, plaintext: unknown, key = KEY) => {
        const response = await manager.handleRequest({
            method: `machine-1:${method}`,
            params: encodeBase64(encrypt(key, 'dataKey', plaintext as object)),
        } as never);
        return decrypt(key, 'dataKey', decodeBase64(response as string));
    };

    it('runs the handler with the bound params and binds the reply to the nonce', async () => {
        const { manager, calls } = makeBound();
        expect(await send(manager, 'readFile', bound('readFile', { path: '/w/a' }, { nonce: nonce(2) })))
            .toEqual({ rpcBinding: 1, nonce: nonce(2), result: { content: 'x' } });
        expect(calls).toEqual([['readFile', { path: '/w/a' }]]);
    });

    it('refuses a request sent to another method than the one it names', async () => {
        const { manager, calls } = makeBound();
        expect(await send(manager, 'deleteFile', bound('readFile', { path: '/w/a' }, { nonce: nonce(3) })))
            .toEqual({ rpcBinding: 1, nonce: nonce(3), result: expect.objectContaining({ code: 'RPC_METHOD_MISMATCH' }) });
        expect(calls).toEqual([]);
    });

    it('refuses a request bound to another scope', async () => {
        const { manager, calls } = makeBound();
        expect(await send(manager, 'readFile', bound('readFile', {}, { nonce: nonce(4), scope: 'machine-2' })))
            .toMatchObject({ nonce: nonce(4), result: { code: 'RPC_SCOPE_MISMATCH' } });
        expect(calls).toEqual([]);
    });

    it('runs a request once and refuses it when it comes again', async () => {
        const { manager, calls } = makeBound();
        const request = bound('readFile', { path: '/w/a' }, { nonce: nonce(5) });
        await send(manager, 'readFile', request);
        expect(await send(manager, 'readFile', request)).toMatchObject({ nonce: nonce(5), result: { code: 'RPC_REQUEST_REPLAYED' } });
        expect(calls).toHaveLength(1);
    });

    // The refusal names the likely cause: the caller shows it to a person whose clock is off.
    // Forgetting the first nonce to make room would let its request run again.
    it('refuses new requests under strict when the window holds as many as it can remember', async () => {
        const { manager, calls } = makeBound(true, undefined, 1);
        const first = bound('readFile', { path: '/w/a' }, { nonce: nonce(13) });
        await send(manager, 'readFile', first);

        expect(await send(manager, 'readFile', bound('readFile', { path: '/w/b' }, { nonce: nonce(14) })))
            .toMatchObject({ nonce: nonce(14), result: { code: 'RPC_TOO_MANY_REQUESTS' } });
        expect(await send(manager, 'readFile', first)).toMatchObject({ nonce: nonce(13), result: { code: 'RPC_REQUEST_REPLAYED' } });
        expect(calls).toEqual([['readFile', { path: '/w/a' }]]);
    });

    it('refuses a request issued outside the window under strict, naming the clocks', async () => {
        const { manager, calls } = makeBound(true);
        expect(await send(manager, 'readFile', bound('readFile', {}, { nonce: nonce(6), issuedAt: Date.now() - 10 * 60_000 })))
            .toMatchObject({ nonce: nonce(6), result: { code: 'RPC_REQUEST_STALE', error: expect.stringMatching(/clock/) } });
        expect(calls).toEqual([]);
    });

    // Under compat the server can already obtain the machine key, so the window would only
    // refuse a client whose clock is off, such as a dual-boot PC nine hours out.
    it('runs a request issued outside the window under compat, once', async () => {
        const { manager, calls } = makeBound(false);
        const nineHours = 9 * 60 * 60_000;
        for (const [fill, issuedAt] of [[11, Date.now() - nineHours], [12, Date.now() + nineHours]] as const) {
            const request = bound('readFile', { path: '/w/a' }, { nonce: nonce(fill), issuedAt });
            expect(await send(manager, 'readFile', request)).toEqual({ rpcBinding: 1, nonce: nonce(fill), result: { content: 'x' } });
            expect(await send(manager, 'readFile', request)).toMatchObject({ nonce: nonce(fill), result: { code: 'RPC_REQUEST_REPLAYED' } });
        }
        expect(calls).toHaveLength(2);
    });

    it('binds the reply to a method that does not exist and to a policy refusal', async () => {
        const { manager } = makeBound();
        expect(await send(manager, 'nope', bound('nope', {}, { nonce: nonce(7) })))
            .toEqual({ rpcBinding: 1, nonce: nonce(7), result: { error: 'Method not found' } });
        manager.setMethodPolicy((method) => method === 'readFile' ? { error: 'Unavailable', code: 'TRIAL_UNAVAILABLE' } : null);
        expect(await send(manager, 'readFile', bound('readFile', {}, { nonce: nonce(8) })))
            .toEqual({ rpcBinding: 1, nonce: nonce(8), result: { error: 'Unavailable', code: 'TRIAL_UNAVAILABLE' } });
    });

    it('answers a traced bound request with a bound reply', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionKey: KEY, encryptionVariant: 'dataKey', logger: () => {} });
        manager.registerHandler('daemon-session-state', async () => ({ state: 'present' }));
        const response = await manager.handleRequest({
            method: 'machine-1:daemon-session-state',
            params: encodeBase64(encrypt(KEY, 'dataKey', bound('daemon-session-state', { sessionId: 's' }, { nonce: nonce(9) }))),
            rpcLatency: { version: 1, id: '44444444-4444-4444-8444-444444444444' },
        } as never);
        expect(decrypt(KEY, 'dataKey', decodeBase64(response.result))).toEqual({ rpcBinding: 1, nonce: nonce(9), result: { state: 'present' } });
    });

    it('keeps running unbound requests under compat', async () => {
        const { manager, calls } = makeBound(false);
        expect(await send(manager, 'readFile', { path: '/w/a' })).toEqual({ content: 'x' });
        expect(calls).toEqual([['readFile', { path: '/w/a' }]]);
    });

    // A stored metadata blob sealed with the machine key opens as a plain object, so under
    // compat it could still be handed to a handler that ignores its params.
    it('refuses unbound requests under strict, even for a handler that ignores its params', async () => {
        const { manager, calls } = makeBound(true);
        expect(await send(manager, 'stop-daemon', { host: 'h', platform: 'darwin' })).toMatchObject({ code: 'RPC_UNBOUND_REQUEST' });
        expect(await send(manager, 'readFile', { path: '/w/a' })).toMatchObject({ code: 'RPC_UNBOUND_REQUEST' });
        expect(calls).toEqual([]);
        expect(await send(manager, 'stop-daemon', bound('stop-daemon', undefined, { nonce: nonce(10) })))
            .toEqual({ rpcBinding: 1, nonce: nonce(10), result: { message: 'stopping' } });
        expect(calls).toEqual([['stop-daemon', null]]);
    });

    it('leaves the server lane to its allowlist under strict', async () => {
        const SERVER_KEY = new Uint8Array(randomBytes(32));
        const { manager, calls } = makeBound(true, { encryptionKey: SERVER_KEY, allows: (method) => method === 'readFile' });
        expect(await send(manager, 'readFile', { path: '/w/a' }, SERVER_KEY)).toEqual({ content: 'x' });
        expect(calls).toEqual([['readFile', { path: '/w/a' }]]);
    });
});
