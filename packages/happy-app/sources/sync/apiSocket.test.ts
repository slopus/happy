import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Encryption } from './encryption/encryption';

const mocks = vi.hoisted(() => {
    const rpcEmitWithAck = vi.fn();
    const socket = {
        connected: false,
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        on: vi.fn(),
        onAny: vi.fn(),
        recovered: false,
        timeout: vi.fn(() => ({ emitWithAck: rpcEmitWithAck })),
    };

    return { rpcEmitWithAck, socket };
});

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => mocks.socket),
}));

vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Platform: { OS: 'android' },
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '1.0.0' } },
}));

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: { getCredentials: vi.fn() },
}));

vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ localSettings: { verboseLogging: false } }),
    },
}));

import { ApiSocket, DEFAULT_RPC_ACK_TIMEOUT_MS } from './apiSocket';

function createEncryption() {
    const sessionEncryption = {
        encryptRaw: vi.fn().mockResolvedValue('encrypted-session-params'),
        decryptRaw: vi.fn().mockResolvedValue({ stopped: true }),
    };
    const machineEncryption = {
        encryptRaw: vi.fn().mockResolvedValue('encrypted-machine-params'),
        decryptRaw: vi.fn().mockResolvedValue({ restarted: true }),
    };
    const encryption = {
        getSessionEncryption: vi.fn(() => sessionEncryption),
        getMachineEncryption: vi.fn(() => machineEncryption),
    } as unknown as Encryption;

    return { encryption, machineEncryption, sessionEncryption };
}

function createApiSocket(encryption: Encryption): ApiSocket {
    const socket = new ApiSocket();
    socket.initialize({ endpoint: 'https://example.test', token: 'token' }, encryption);
    return socket;
}

describe('ApiSocket RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.socket.connected = false;
        mocks.socket.timeout.mockReturnValue({ emitWithAck: mocks.rpcEmitWithAck });
    });

    it('rejects immediately while disconnected without encrypting or emitting', async () => {
        const { encryption, sessionEncryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.sessionRPC('session-1', 'abort', {}))
            .rejects.toThrow('Socket not connected');

        expect(sessionEncryption.encryptRaw).not.toHaveBeenCalled();
        expect(mocks.socket.timeout).not.toHaveBeenCalled();
        expect(mocks.rpcEmitWithAck).not.toHaveBeenCalled();
    });

    it('uses the default acknowledgement timeout and decrypts a successful session RPC', async () => {
        mocks.socket.connected = true;
        mocks.rpcEmitWithAck.mockResolvedValue({ ok: true, result: 'encrypted-result' });
        const { encryption, sessionEncryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.sessionRPC('session-1', 'abort', { reason: 'user' }))
            .resolves.toEqual({ stopped: true });

        expect(mocks.socket.timeout).toHaveBeenCalledWith(DEFAULT_RPC_ACK_TIMEOUT_MS);
        expect(mocks.rpcEmitWithAck).toHaveBeenCalledWith('rpc-call', {
            method: 'session-1:abort',
            params: 'encrypted-session-params',
        });
        expect(sessionEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
    });

    it('uses a caller-supplied acknowledgement timeout for machine RPCs', async () => {
        mocks.socket.connected = true;
        mocks.rpcEmitWithAck.mockResolvedValue({ ok: true, result: 'encrypted-result' });
        const { encryption, machineEncryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.machineRPC('machine-1', 'restart', { force: true }, { timeoutMs: 120_000 }))
            .resolves.toEqual({ restarted: true });

        expect(mocks.socket.timeout).toHaveBeenCalledWith(120_000);
        expect(mocks.rpcEmitWithAck).toHaveBeenCalledWith('rpc-call', {
            method: 'machine-1:restart',
            params: 'encrypted-machine-params',
        });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
    });

    it('does not emit when the socket disconnects while parameters are being encrypted', async () => {
        mocks.socket.connected = true;
        let finishEncryption!: (value: string) => void;
        const encryptionPending = new Promise<string>((resolve) => {
            finishEncryption = resolve;
        });
        const { encryption, sessionEncryption } = createEncryption();
        sessionEncryption.encryptRaw.mockReturnValueOnce(encryptionPending);
        const socket = createApiSocket(encryption);

        const request = socket.sessionRPC('session-1', 'abort', {});
        socket.disconnect();
        finishEncryption('encrypted-session-params');

        await expect(request).rejects.toThrow('Socket not connected');
        expect(mocks.rpcEmitWithAck).not.toHaveBeenCalled();
    });

    it('propagates a server RPC error without attempting to decrypt it', async () => {
        mocks.socket.connected = true;
        mocks.rpcEmitWithAck.mockResolvedValue({ ok: false, error: 'RPC method not available' });
        const { encryption, sessionEncryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.sessionRPC('session-1', 'abort', {}))
            .rejects.toThrow('RPC method not available');

        expect(sessionEncryption.decryptRaw).not.toHaveBeenCalled();
    });

    it('rejects malformed successful acknowledgements without decrypting them', async () => {
        mocks.socket.connected = true;
        mocks.rpcEmitWithAck.mockResolvedValue({ ok: true });
        const { encryption, sessionEncryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.sessionRPC('session-1', 'abort', {}))
            .rejects.toThrow('RPC call failed');

        expect(sessionEncryption.decryptRaw).not.toHaveBeenCalled();
    });

    it('settles when Socket.IO rejects after the acknowledgement timeout', async () => {
        mocks.socket.connected = true;
        mocks.rpcEmitWithAck.mockRejectedValue(new Error('operation has timed out'));
        const { encryption } = createEncryption();
        const socket = createApiSocket(encryption);

        await expect(socket.sessionRPC('session-1', 'abort', {}))
            .rejects.toThrow('operation has timed out');
    });
});
