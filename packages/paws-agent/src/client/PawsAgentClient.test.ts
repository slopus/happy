import { describe, expect, it, vi } from 'vitest';
import type { Machine } from './types';
import { PawsAgentClient } from './PawsAgentClient';

describe('PawsAgentClient', () => {
    it('composes resources without connecting during construction', async () => {
        const credentials = {
            getCredentials: vi.fn(), setCredentials: vi.fn(), clearCredentials: vi.fn(),
        };
        const client = new PawsAgentClient({ serverUrl: 'https://paws.example', credentials });

        expect(credentials.getCredentials).not.toHaveBeenCalled();
        expect(client.machines).toBeDefined();
        expect(client.sessions).toBeDefined();
        expect(client.messages).toBeDefined();
        expect(client.requests).toBeDefined();

        await client.dispose();
    });

    it('publishes a refreshed machine snapshot after realtime machine updates', async () => {
        const credentials = {
            getCredentials: vi.fn(), setCredentials: vi.fn(), clearCredentials: vi.fn(),
        };
        const client = new PawsAgentClient({ serverUrl: 'https://paws.example', credentials });
        const machine: Machine = {
            id: 'machine-1',
            seq: 2,
            createdAt: 1,
            updatedAt: 3,
            active: false,
            activeAt: 2,
            metadata: { host: 'studio.local' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        vi.spyOn(client.machines, 'list').mockResolvedValue([machine]);
        const listener = vi.fn();
        client.subscribe(listener);

        await (client as unknown as { handleUpdate(update: unknown): Promise<void> })
            .handleUpdate({ body: { t: 'update-machine', id: machine.id } });

        expect(listener).toHaveBeenCalledWith({ type: 'machines', machines: [machine] });
        await client.dispose();
    });
});
