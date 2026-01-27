import { describe, it, expect } from 'vitest';
import { createRpcCallError, isRpcMethodNotAvailableError } from './rpcErrors';
import { RPC_ERROR_CODES } from '@happy/protocol/rpc';

describe('rpcErrors', () => {
  it('creates an Error with rpcErrorCode when provided', () => {
    const err = createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(err.message).toBe('RPC method not available');
    expect((err as any).rpcErrorCode).toBe('RPC_METHOD_NOT_AVAILABLE');
  });

  it('creates an Error without rpcErrorCode when missing', () => {
    const err = createRpcCallError({ error: 'boom' });
    expect(err.message).toBe('boom');
    expect((err as any).rpcErrorCode).toBeUndefined();
  });

  it('detects RPC method unavailable by explicit errorCode', () => {
    expect(isRpcMethodNotAvailableError({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, message: 'anything' })).toBe(true);
  });

  it('detects RPC method unavailable by legacy message (case-insensitive)', () => {
    expect(isRpcMethodNotAvailableError({ message: 'RPC method not available' })).toBe(true);
    expect(isRpcMethodNotAvailableError({ message: 'rpc METHOD NOT available ' })).toBe(true);
  });
});
