import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSessionRPC } = vi.hoisted(() => ({
  mockSessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
  apiSocket: {
    sessionRPC: mockSessionRPC,
  },
}));

// ops.ts imports ./sync, which pulls in Expo-native modules in node/vitest.
// sessionAbort doesn't use sync, so we provide a lightweight mock.
vi.mock('./sync', () => ({
  sync: {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
    },
  },
}));

import { sessionAbort } from './ops';
import { RPC_ERROR_CODES } from '@happy/protocol/rpc';

describe('sessionAbort', () => {
  beforeEach(() => {
    mockSessionRPC.mockReset();
  });

  it('does not throw when RPC method is unavailable (errorCode)', async () => {
    const err: any = new Error('RPC method not available');
    err.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
    mockSessionRPC.mockRejectedValue(err);

    await expect(sessionAbort('sid-1')).resolves.toBeUndefined();
  });

  it('keeps backward compatibility by not throwing on the legacy error message', async () => {
    mockSessionRPC.mockRejectedValue(new Error('RPC method not available'));

    await expect(sessionAbort('sid-2')).resolves.toBeUndefined();
  });

  it('rethrows non-RPC-method-unavailable failures', async () => {
    mockSessionRPC.mockRejectedValue(new Error('boom'));

    await expect(sessionAbort('sid-3')).rejects.toThrow('boom');
  });
});
