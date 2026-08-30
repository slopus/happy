import { describe, expect, it, vi } from 'vitest';

import { createRelationshipAdvisorPluginRuntime } from '@/modules/relationship-advisor/relationshipAdvisorPlugin';

const configuration = {
    apiKey: 'server-stored-secret',
    baseUrl: 'https://api.example.com/v1',
    model: 'example-chat',
};

describe('createRelationshipAdvisorPluginRuntime', () => {
    it('opens one capability context for provider and secret access', async () => {
        const openRuntime = vi.fn(async () => configuration);
        const plugin = createRelationshipAdvisorPluginRuntime({ openRuntime });

        await expect(plugin.openRuntime('user-4', { includeImages: false })).resolves.toEqual(configuration);

        expect(openRuntime).toHaveBeenCalledTimes(1);
        expect(openRuntime).toHaveBeenCalledWith('user-4', 'relationship-advisor', [
            'paws.ai.provider.invoke',
            'paws.secrets.use',
        ]);
    });

    it('adds image capabilities to the same context before image references are resolved', async () => {
        const openRuntime = vi.fn(async () => configuration);
        const plugin = createRelationshipAdvisorPluginRuntime({ openRuntime });

        await plugin.openRuntime('user-4', { includeImages: true });

        expect(openRuntime).toHaveBeenCalledTimes(1);
        expect(openRuntime).toHaveBeenCalledWith('user-4', 'relationship-advisor', [
            'paws.ai.provider.invoke',
            'paws.secrets.use',
            'paws.conversations.images.read',
            'paws.storage.images.write',
        ]);
    });

    it('opens a one-call image-write context for HTTP upload routes', async () => {
        const openRuntime = vi.fn(async () => configuration);
        const plugin = createRelationshipAdvisorPluginRuntime({ openRuntime });

        await plugin.openImageWriteRuntime('user-4');

        expect(openRuntime).toHaveBeenCalledTimes(1);
        expect(openRuntime).toHaveBeenCalledWith('user-4', 'relationship-advisor', [
            'paws.storage.images.write',
        ]);
    });
});
