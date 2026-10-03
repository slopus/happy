import { describe, expect, it, vi } from 'vitest';
import type { DecryptedMachine } from './api';
import type { Config } from './config';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { resumeSessionOnMachine, spawnSessionOnMachine } from './machineRpc';

type Call = { method: string; params: string };
let daemon: (call: Call) => unknown = () => ({ ok: false, error: 'no daemon' });
const calls: Call[] = [];

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => ({
        connected: true,
        connect: () => undefined,
        once: () => undefined,
        off: () => undefined,
        close: () => undefined,
        timeout: () => ({
            emitWithAck: async (_event: string, call: Call) => {
                calls.push(call);
                return daemon(call);
            },
        }),
    })),
}));

const config = { serverUrl: 'https://server.test' } as Config;
const key = new Uint8Array(32).fill(5);
const machine = (variant: 'legacy' | 'dataKey', metadata: unknown = null): DecryptedMachine => ({
    id: 'machine-1', seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
    metadata, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null,
    encryption: { key, variant },
});
const opened = (call: Call, variant: 'legacy' | 'dataKey') => decrypt(key, variant, decodeBase64(call.params));
const sealed = (value: unknown, variant: 'legacy' | 'dataKey') => ({ ok: true, result: encodeBase64(encrypt(key, variant, value)) });

describe('spawnSessionOnMachine', () => {
    it('asks the machine to spawn in the directory and returns its answer', async () => {
        calls.length = 0;
        daemon = () => sealed({ type: 'success', sessionId: 'session-1' }, 'dataKey');

        expect(await spawnSessionOnMachine(config, machine('dataKey'), 'token', { directory: '/w', agent: 'codex' }))
            .toEqual({ type: 'success', sessionId: 'session-1' });
        expect(calls[0]!.method).toBe('machine-1:spawn-happy-session');
        expect(opened(calls[0]!, 'dataKey')).toEqual({
            type: 'spawn-in-directory', directory: '/w', approvedNewDirectoryCreation: false, agent: 'codex',
        });
    });

    it('surfaces the daemon error and an offline machine', async () => {
        daemon = () => sealed({ error: 'boom' }, 'legacy');
        await expect(spawnSessionOnMachine(config, machine('legacy'), 'token', { directory: '/w' })).rejects.toThrow('boom');

        daemon = () => ({ ok: false, error: 'RPC method not available' });
        await expect(spawnSessionOnMachine(config, machine('legacy'), 'token', { directory: '/w' }))
            .rejects.toThrow('Machine machine-1 is offline or its daemon is not connected.');
    });
});

describe('resumeSessionOnMachine', () => {
    it('asks the machine to resume the session and returns its answer', async () => {
        calls.length = 0;
        daemon = () => sealed({ type: 'success', sessionId: 'session-1' }, 'legacy');

        expect(await resumeSessionOnMachine(config, machine('legacy'), 'token', 'session-1')).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(calls[0]!.method).toBe('machine-1:resume-happy-session');
        expect(opened(calls[0]!, 'legacy')).toEqual({ sessionId: 'session-1' });
    });

    it('refuses an answer that is not a spawn result', async () => {
        daemon = () => sealed({ type: 'surprise' }, 'legacy');
        await expect(resumeSessionOnMachine(config, machine('legacy'), 'token', 'session-1')).rejects.toThrow('RPC call returned unexpected data');
    });
});
