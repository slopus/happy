/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — a customer-lane RPC
 * carries its method, scope, issue time and nonce inside the ciphertext, and
 * the reply carries the nonce back.
 */
import { describe, expect, it } from 'vitest';
import {
  RPC_BINDING_WINDOW_MS,
  bindRpcRequest,
  bindRpcResponse,
  readBoundRpcRequest,
  readBoundRpcResponse,
  rpcBindingCapabilitySchema,
} from './rpcBinding';

const nonce = Buffer.alloc(16, 7).toString('base64');
const issuedAt = 1_790_000_000_000;
const request = bindRpcRequest({ method: 'readFile', scope: 'machine-1', params: { path: '/w/a.txt' }, issuedAt, nonce });
const expected = { method: 'readFile', scope: 'machine-1', now: issuedAt + 1_000 };

describe('bound RPC requests', () => {
  it('reads back the params of a request for the same method and scope', () => {
    expect(request).toEqual({ rpcBinding: 1, method: 'readFile', scope: 'machine-1', issuedAt, nonce, params: { path: '/w/a.txt' } });
    expect(readBoundRpcRequest(JSON.parse(JSON.stringify(request)), expected))
      .toEqual({ kind: 'bound', params: { path: '/w/a.txt' }, nonce, issuedAt });
  });

  it('reads a parameterless request as null params', () => {
    const bare = JSON.parse(JSON.stringify(bindRpcRequest({ method: 'stop-daemon', scope: 'machine-1', params: undefined, issuedAt, nonce })));
    expect(readBoundRpcRequest(bare, { ...expected, method: 'stop-daemon' })).toEqual({ kind: 'bound', params: null, nonce, issuedAt });
  });

  it('refuses a request sent to another method or scope, keeping its nonce for the reply', () => {
    expect(readBoundRpcRequest(request, { ...expected, method: 'deleteFile' }))
      .toEqual({ kind: 'refused', code: 'RPC_METHOD_MISMATCH', nonce });
    expect(readBoundRpcRequest(request, { ...expected, scope: 'machine-2' }))
      .toEqual({ kind: 'refused', code: 'RPC_SCOPE_MISMATCH', nonce });
  });

  it('refuses a request issued outside the window on either side', () => {
    expect(readBoundRpcRequest(request, { ...expected, now: issuedAt + RPC_BINDING_WINDOW_MS })).toMatchObject({ kind: 'bound' });
    expect(readBoundRpcRequest(request, { ...expected, now: issuedAt + RPC_BINDING_WINDOW_MS + 1 }))
      .toEqual({ kind: 'refused', code: 'RPC_REQUEST_STALE', nonce });
    expect(readBoundRpcRequest(request, { ...expected, now: issuedAt - RPC_BINDING_WINDOW_MS - 1 }))
      .toEqual({ kind: 'refused', code: 'RPC_REQUEST_STALE', nonce });
  });

  // A compat receiver: the server can already obtain its scope key, so the window would only
  // refuse a client whose clock is off. It still checks the method and scope.
  it('reports a request outside the window instead of refusing it when the receiver allows stale ones', () => {
    for (const now of [issuedAt + RPC_BINDING_WINDOW_MS + 1, issuedAt - RPC_BINDING_WINDOW_MS - 1]) {
      expect(readBoundRpcRequest(request, { ...expected, now, allowStale: true }))
        .toEqual({ kind: 'bound', params: { path: '/w/a.txt' }, nonce, issuedAt, stale: true });
    }
    expect(readBoundRpcRequest(request, { ...expected, allowStale: true }))
      .toEqual({ kind: 'bound', params: { path: '/w/a.txt' }, nonce, issuedAt });
    expect(readBoundRpcRequest(request, { ...expected, method: 'deleteFile', allowStale: true }))
      .toEqual({ kind: 'refused', code: 'RPC_METHOD_MISMATCH', nonce });
    expect(readBoundRpcRequest(request, { ...expected, scope: 'machine-2', allowStale: true }))
      .toEqual({ kind: 'refused', code: 'RPC_SCOPE_MISMATCH', nonce });
  });

  it('refuses a malformed bound request', () => {
    for (const broken of [
      { ...request, rpcBinding: 2 },
      { ...request, nonce: 'short' },
      { ...request, method: '' },
      { ...request, issuedAt: -1 },
      { ...request, issuedAt: 1.5 },
      { ...request, extra: true },
    ]) {
      expect(readBoundRpcRequest(broken, expected)).toMatchObject({ kind: 'refused', code: 'RPC_BINDING_MALFORMED' });
    }
  });

  it('treats anything without the binding mark as an unbound request', () => {
    for (const value of [null, undefined, 'text', 3, [], { path: '/w/a.txt' }, { method: 'readFile' }]) {
      expect(readBoundRpcRequest(value, expected)).toEqual({ kind: 'unbound' });
    }
  });
});

describe('bound RPC responses', () => {
  it('returns the result of the reply to this request', () => {
    const reply = JSON.parse(JSON.stringify(bindRpcResponse(nonce, { success: true, content: 'x' })));
    expect(reply).toEqual({ rpcBinding: 1, nonce, result: { success: true, content: 'x' } });
    expect(readBoundRpcResponse(reply, nonce)).toEqual({ ok: true, result: { success: true, content: 'x' } });
    expect(readBoundRpcResponse(JSON.parse(JSON.stringify(bindRpcResponse(nonce, undefined))), nonce)).toEqual({ ok: true, result: null });
  });

  it('refuses a reply to another request and a reply that is not bound', () => {
    const other = Buffer.alloc(16, 8).toString('base64');
    expect(readBoundRpcResponse(bindRpcResponse(other, { success: true }), nonce)).toEqual({ ok: false, code: 'RPC_RESPONSE_MISMATCH' });
    expect(readBoundRpcResponse({ success: true }, nonce)).toEqual({ ok: false, code: 'RPC_RESPONSE_UNBOUND' });
    expect(readBoundRpcResponse(null, nonce)).toEqual({ ok: false, code: 'RPC_RESPONSE_UNBOUND' });
  });
});

describe('rpcBindingCapabilitySchema', () => {
  it('accepts version 1 only', () => {
    expect(rpcBindingCapabilitySchema.parse({ version: 1 })).toEqual({ version: 1 });
    expect(rpcBindingCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
