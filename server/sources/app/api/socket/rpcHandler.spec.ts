import { describe, it, expect, vi } from 'vitest';
import { rpcHandler } from './rpcHandler';
import { RPC_ERROR_CODES } from '@happy/protocol/rpc';

class FakeSocket {
  public connected = true;
  public id = 'fake-socket';
  public handlers = new Map<string, any>();
  public emit = vi.fn();

  on(event: string, handler: any) {
    this.handlers.set(event, handler);
  }

  timeout() {
    return {
      emitWithAck: async () => {
        throw new Error('not implemented');
      },
    };
  }
}

describe('rpcHandler', () => {
  it('returns an explicit errorCode when the RPC method is not available', async () => {
    const socket = new FakeSocket();
    const rpcListeners = new Map<string, any>();

    rpcHandler('user-1', socket as any, rpcListeners as any);

    const handler = socket.handlers.get('rpc-call');
    expect(typeof handler).toBe('function');

    const callback = vi.fn();
    await handler({ method: 'missing-method', params: {} }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: 'RPC method not available',
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
  });
});
