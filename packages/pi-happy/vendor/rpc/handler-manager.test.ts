import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from 'happy-agent/encryption';

import { RpcHandlerManager } from './handler-manager';

function createManager(variant: 'legacy' | 'dataKey' = 'legacy'): {
  manager: RpcHandlerManager;
  encryptionKey: Uint8Array;
} {
  const encryptionKey = getRandomBytes(32);
  const manager = new RpcHandlerManager({
    scopePrefix: 'session-123',
    encryptionKey,
    encryptionVariant: variant,
  });
  return { manager, encryptionKey };
}

describe('RpcHandlerManager', () => {
  it('decrypts params, invokes the handler, and encrypts the response', async () => {
    const { manager, encryptionKey } = createManager();
    manager.registerHandler<{ value: number }, { doubled: number }>('double', async data => ({
      doubled: data.value * 2,
    }));

    const response = await manager.handleRequest({
      method: 'session-123:double',
      params: encodeBase64(encrypt(encryptionKey, 'legacy', { value: 21 })),
    });

    expect(decrypt(encryptionKey, 'legacy', decodeBase64(response))).toEqual({ doubled: 42 });
  });

  it('returns an encrypted error when the method is missing', async () => {
    const { manager, encryptionKey } = createManager();

    const response = await manager.handleRequest({
      method: 'session-123:missing',
      params: encodeBase64(encrypt(encryptionKey, 'legacy', {})),
    });

    expect(decrypt(encryptionKey, 'legacy', decodeBase64(response))).toEqual({
      error: 'Method not found',
    });
  });

  it('returns an encrypted handler error', async () => {
    const { manager, encryptionKey } = createManager('dataKey');
    manager.registerHandler('explode', async () => {
      throw new Error('kaboom');
    });

    const response = await manager.handleRequest({
      method: 'session-123:explode',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', {})),
    });

    expect(decrypt(encryptionKey, 'dataKey', decodeBase64(response))).toEqual({
      error: 'kaboom',
    });
  });

  it('registers and unregisters handlers with the socket connection', () => {
    const { manager } = createManager();
    const socket = { emit: vi.fn() } as unknown as { emit: ReturnType<typeof vi.fn> };

    manager.registerHandler('readFile', async () => ({ ok: true }));
    manager.registerHandler('writeFile', async () => ({ ok: true }));
    manager.onSocketConnect(socket as never);

    expect(socket.emit).toHaveBeenCalledWith('rpc-register', { method: 'session-123:readFile' });
    expect(socket.emit).toHaveBeenCalledWith('rpc-register', { method: 'session-123:writeFile' });

    manager.unregisterHandler('writeFile');
    expect(socket.emit).toHaveBeenCalledWith('rpc-unregister', { method: 'session-123:writeFile' });
  });

  it('tracks handler presence and can clear everything', () => {
    const { manager } = createManager();
    manager.registerHandler('bash', async () => ({ ok: true }));

    expect(manager.hasHandler('bash')).toBe(true);
    expect(manager.getHandlerCount()).toBe(1);

    manager.clearHandlers();

    expect(manager.hasHandler('bash')).toBe(false);
    expect(manager.getHandlerCount()).toBe(0);
  });
});
