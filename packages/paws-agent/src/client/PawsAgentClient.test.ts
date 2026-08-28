import { describe, expect, it, vi } from 'vitest';
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
});
