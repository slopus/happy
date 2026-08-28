import { describe, expect, it, vi } from 'vitest';
import { PawsAgentEvents } from '../client/events';
import { RecordEncryptionStore } from '../crypto/records';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../crypto/encryption';
import { PawsRealtimeTransport } from './realtime';

class MockSocket {
    connected = false;
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(event: string, listener: (...args: any[]) => void) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return this;
    }
    connect() { this.connected = true; return this; }
    disconnect() { this.connected = false; return this; }
    close() { this.connected = false; return this; }
    emit() { return true; }
    timeout() { return this; }
    emitWithAck = vi.fn();
    server(event: string, ...args: any[]) {
        for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
}

const credentials = {
    token: 'token',
    secret: new Uint8Array(32),
    contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
};

describe('PawsRealtimeTransport', () => {
    it('resynchronizes before emitting ready after reconnect', async () => {
        const socket = new MockSocket();
        const resync = vi.fn().mockResolvedValue(undefined);
        const seen: string[] = [];
        const events = new PawsAgentEvents();
        events.subscribe(event => {
            if (event.type === 'connection') seen.push(event.state);
        });
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption: new RecordEncryptionStore(),
            events,
            resync,
            socketFactory: vi.fn(() => socket as never),
        });

        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;
        socket.server('disconnect', 'transport close');
        socket.connected = true;
        socket.server('connect');
        await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(2));

        expect(seen).toEqual(['connecting', 'ready', 'reconnecting', 'ready']);
    });

    it('disconnects idempotently and suppresses later callbacks', async () => {
        const socket = new MockSocket();
        const events = new PawsAgentEvents();
        const seen = vi.fn();
        events.subscribe(seen);
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption: new RecordEncryptionStore(),
            events,
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;
        await realtime.dispose();
        const callCount = seen.mock.calls.length;
        socket.server('connect');
        expect(seen).toHaveBeenCalledTimes(callCount);
    });

    it('rejects a pending connection when disposed', async () => {
        const socket = new MockSocket();
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption: new RecordEncryptionStore(),
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });

        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        await realtime.dispose();

        const outcome = await Promise.race([
            connecting.catch(error => error),
            new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
        ]);
        expect(outcome).toMatchObject({ code: 'CONNECTION_LOST' });
    });

    it('uses the loaded record key for existing session RPC envelopes', async () => {
        const socket = new MockSocket();
        const encryption = new RecordEncryptionStore();
        encryption.setSession('session-1', { key: credentials.secret, variant: 'legacy' });
        socket.emitWithAck.mockImplementation(async (_event, payload: { method: string; params: string }) => {
            expect(payload.method).toBe('session-1:permission');
            expect(decrypt(credentials.secret, 'legacy', decodeBase64(payload.params))).toEqual({ id: 'r1', approved: true });
            return { ok: true, result: encodeBase64(encrypt(credentials.secret, 'legacy', { accepted: true })) };
        });
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption,
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;

        await expect(realtime.sessionRpc('session-1', 'permission', { id: 'r1', approved: true }))
            .resolves.toEqual({ accepted: true });
    });

    it('rejects malformed successful RPC acknowledgements', async () => {
        const socket = new MockSocket();
        const encryption = new RecordEncryptionStore();
        encryption.setSession('session-1', { key: credentials.secret, variant: 'legacy' });
        socket.emitWithAck.mockResolvedValue({ ok: true });
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption,
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;

        await expect(realtime.sessionRpc('session-1', 'permission', { id: 'r1' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    });

    it('reports encrypted RPC payload corruption as a decryption failure', async () => {
        const socket = new MockSocket();
        const encryption = new RecordEncryptionStore();
        encryption.setSession('session-1', { key: credentials.secret, variant: 'legacy' });
        socket.emitWithAck.mockResolvedValue({ ok: true, result: 'not-valid-base64' });
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption,
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;

        await expect(realtime.sessionRpc('session-1', 'permission', { id: 'r1' }))
            .rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    });

    it('normalizes a timed-out acknowledgement', async () => {
        const socket = new MockSocket();
        const encryption = new RecordEncryptionStore();
        encryption.setMachine('machine-1', { key: credentials.secret, variant: 'legacy' });
        socket.emitWithAck.mockRejectedValue(new Error('operation has timed out'));
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption,
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;

        await expect(realtime.machineRpc('machine-1', 'spawn-happy-session', {}))
            .rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    });

    it('normalizes a server-side RPC timeout response', async () => {
        const socket = new MockSocket();
        const encryption = new RecordEncryptionStore();
        encryption.setSession('session-1', { key: credentials.secret, variant: 'legacy' });
        socket.emitWithAck.mockResolvedValue({ ok: false, error: 'operation has timed out' });
        const realtime = new PawsRealtimeTransport({
            serverUrl: 'https://paws.example',
            credentials: { getCredentials: vi.fn().mockResolvedValue(credentials) } as never,
            encryption,
            events: new PawsAgentEvents(),
            resync: vi.fn(),
            socketFactory: () => socket as never,
        });
        const connecting = realtime.connect();
        await vi.waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
        socket.server('connect');
        await connecting;

        await expect(realtime.sessionRpc('session-1', 'permission', {}))
            .rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    });
});
