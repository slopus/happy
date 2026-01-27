import type { RpcErrorCode } from '@happy/protocol/rpc';
import { RPC_ERROR_CODES } from '@happy/protocol/rpc';

export type { RpcErrorCode };

/**
 * Create a regular Error instance that also carries a structured RPC error code.
 *
 * Notes:
 * - Backward compatibility: older servers/clients only expose a message string.
 * - Newer clients should prefer `rpcErrorCode` when available.
 */
export function createRpcCallError(opts: { error: string; errorCode?: string | null | undefined }): Error {
  const err = new Error(opts.error);
  if (opts.errorCode && typeof opts.errorCode === 'string') {
    (err as any).rpcErrorCode = opts.errorCode;
  }
  return err;
}

export function isRpcMethodNotAvailableError(err: { rpcErrorCode?: unknown; message?: unknown }): boolean {
  if (err.rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
    return true;
  }
  const msg = typeof err.message === 'string' ? err.message.trim().toLowerCase() : '';
  return msg === 'rpc method not available';
}
