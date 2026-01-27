import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockSessionRPC } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
  apiSocket: {
    send: mockSend,
    sessionRPC: mockSessionRPC,
  },
}));

// ops.ts imports ./sync, which pulls in Expo-native modules in node/vitest.
// sessionArchive doesn't use sync, so we provide a lightweight mock.
vi.mock('./sync', () => ({
  sync: {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
    },
  },
}));

import { sessionArchive } from './ops';
import { RPC_ERROR_CODES } from '@happy/protocol/rpc';

describe('sessionArchive', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSessionRPC.mockReset();
  });

  it('falls back to session-end when RPC method is unavailable (errorCode)', async () => {
    const err: any = new Error('RPC method not available');
    err.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
    mockSessionRPC.mockRejectedValue(err);

    const res = await sessionArchive('sid-1');
    expect(res).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-1', time: expect.any(Number) }),
    );
  });

  it('keeps backward compatibility by falling back to the legacy error message', async () => {
    mockSessionRPC.mockRejectedValue(new Error('RPC method not available'));

    const res = await sessionArchive('sid-2');
    expect(res).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-2', time: expect.any(Number) }),
    );
  });

  it('returns an error for non-RPC-method-unavailable failures', async () => {
    mockSessionRPC.mockRejectedValue(new Error('boom'));

    const res = await sessionArchive('sid-3');
    expect(res).toEqual({ success: false, message: 'boom' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
