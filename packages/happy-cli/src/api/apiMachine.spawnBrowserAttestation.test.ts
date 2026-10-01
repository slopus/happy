/** Shared machines: Studio's session-user attestation reaches spawnSession unchanged, and only as a bounded string. */
import { describe, expect, it, vi } from 'vitest';

const machine = () => ({ id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }) as any;
const handlers = (spawnSession: unknown) => ({
    spawnSession, stopSession: () => Promise.resolve(), requestShutdown: () => Promise.resolve(),
    portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
}) as any;

describe('spawn-happy-session browserAttestation', () => {
    it('forwards the attestation to spawnSession', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machine());
        client.setRPCHandlers(handlers(spawnSession));
        await (client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session')({ directory: '/tmp/project', browserAttestation: 'abp2.h.p.s' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ browserAttestation: 'abp2.h.p.s' }));
    });

    it.each([['a number', 5], ['an empty string', ''], ['an oversized string', 'x'.repeat(4097)]])('refuses %s', async (_label, browserAttestation) => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machine());
        client.setRPCHandlers(handlers(spawnSession));
        await expect((client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session')({ directory: '/tmp/project', browserAttestation })).rejects.toThrow(/attestation/i);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
